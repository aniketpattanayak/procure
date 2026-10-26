resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = aws_subnet.data[*].id
}

resource "random_password" "redis_auth" {
  length  = 48
  special = false
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = var.name
  description          = "${var.name} cache, rate limits, session revocation set"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  port                 = 6379
  parameter_group_name = "default.redis7"

  num_cache_clusters         = 1 + var.redis_replicas
  automatic_failover_enabled = var.redis_replicas > 0
  multi_az_enabled           = var.redis_replicas > 0

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.secrets.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result

  snapshot_retention_limit = 3
  snapshot_window          = "18:30-19:30"
  maintenance_window       = "sun:22:00-sun:23:00"
  apply_immediately        = false

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_slow.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }
}
