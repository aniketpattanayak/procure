locals {
  app_services = {
    api    = { port = 4000, health_path = "/health", public = true }
    web    = { port = 3000, health_path = "/", public = true }
    worker = { port = 0, health_path = "", public = false }
  }
  public_services = { for k, v in local.app_services : k => v if v.public }

  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "API_PORT", value = "4000" },
    { name = "WEB_ORIGIN", value = "https://${var.web_hostname}" },
    { name = "COOKIE_SECURE", value = "true" },
    # Files (apps/api/src/core/config.ts): S3 driver, bucket + region; signed URLs are absolute so links in emails
    # and the PDF renderer's file allow-list work.
    { name = "STORAGE_DRIVER", value = "s3" },
    { name = "S3_BUCKET", value = aws_s3_bucket.files.bucket },
    { name = "S3_REGION", value = data.aws_region.current.name },
    { name = "FILE_URL_BASE", value = "https://${var.api_hostname}" },
    { name = "AWS_REGION", value = data.aws_region.current.name },
    # Jobs run in the worker service only.
    { name = "RUN_WORKERS", value = "off" },
  ]
  common_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.app["database_url"].arn },
    { name = "DATABASE_PLATFORM_URL", valueFrom = aws_secretsmanager_secret.app["database_platform_url"].arn },
    { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.app["redis_url"].arn },
    { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.app["jwt_secret"].arn },
    { name = "JWT_SECRET_PREVIOUS", valueFrom = aws_secretsmanager_secret.app["jwt_secret_previous"].arn },
    # These three are required under NODE_ENV=production (the API refuses to boot without them).
    { name = "FILE_URL_SECRET", valueFrom = aws_secretsmanager_secret.app["file_url_secret"].arn },
    { name = "PROVIDER_KEY", valueFrom = aws_secretsmanager_secret.app["provider_key"].arn },
    { name = "AUDIT_HASH_KEY", valueFrom = aws_secretsmanager_secret.app["audit_hash_key"].arn },
    { name = "AUDIT_HASH_KEY_PREVIOUS", valueFrom = aws_secretsmanager_secret.app["audit_hash_key_previous"].arn },
  ]
}

# ---- ECR ---------------------------------------------------------------------------------------
resource "aws_ecr_repository" "this" {
  for_each             = local.app_services
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.secrets.arn
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 50 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 50 }
      action       = { type = "expire" }
    }]
  })
}

# ---- cluster -----------------------------------------------------------------------------------
resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ---- IAM ---------------------------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = concat(
          [for s in aws_secretsmanager_secret.app : s.arn],
          [aws_secretsmanager_secret.migrator_url.arn],
        )
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.secrets.arn]
      },
    ]
  })
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task_files" {
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
        Resource = "${aws_s3_bucket.files.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.files.arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.s3.arn
      },
    ]
  })
}

# ---- task definitions --------------------------------------------------------------------------
resource "aws_ecs_task_definition" "app" {
  for_each                 = local.app_services
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.services[each.key].cpu
  memory                   = var.services[each.key].memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name                   = each.key
    image                  = "${aws_ecr_repository.this[each.key].repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = each.key != "web" # Next writes a cache dir at runtime
    user                   = "10001:10001"
    portMappings           = each.value.port > 0 ? [{ containerPort = each.value.port, protocol = "tcp" }] : []
    environment            = concat(local.common_env, [{ name = "PROCESS_TYPE", value = each.key }])
    secrets                = each.key == "web" ? [] : local.common_secrets
    linuxParameters        = { initProcessEnabled = true }
    # Root FS is read-only for api/worker: Chromium (PDF renders) and export temp files need a writable /tmp.
    mountPoints = each.key == "web" ? [] : [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = each.key
      }
    }
  }])

  # Fargate task storage (ephemeral, per task) backing /tmp.
  volume {
    name = "tmp"
  }

  # Deploys register new revisions from CI; don't fight them.
  lifecycle {
    ignore_changes = [container_definitions]
  }
}

# One-off migrate task (api image, migrator credentials). Run by deploy.yml before rolling services.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = "${aws_ecr_repository.this["api"].repository_url}:${var.image_tag}"
    essential = true
    user      = "10001:10001"
    command   = ["sh", "-c", "node db/migrate.mjs && node db/policies/rls-lint.mjs"]
    secrets = [
      { name = "DATABASE_MIGRATOR_URL", valueFrom = aws_secretsmanager_secret.migrator_url.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["migrate"].name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "migrate"
      }
    }
  }])

  lifecycle {
    ignore_changes = [container_definitions]
  }
}

# ---- services ----------------------------------------------------------------------------------
resource "aws_ecs_service" "app" {
  for_each               = local.app_services
  name                   = each.key
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.app[each.key].arn
  desired_count          = var.services[each.key].desired_count
  launch_type            = "FARGATE"
  enable_execute_command = var.environment != "production"
  propagate_tags         = "SERVICE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.public ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.app[each.key].arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  health_check_grace_period_seconds = each.value.public ? 60 : null

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_appautoscaling_target" "app" {
  for_each           = local.app_services
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.app[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.services[each.key].min_count
  max_capacity       = var.services[each.key].max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = local.app_services
  name               = "${var.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.app[each.key].service_namespace
  resource_id        = aws_appautoscaling_target.app[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.app[each.key].scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
