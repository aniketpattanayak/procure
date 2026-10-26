resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = aws_subnet.data[*].id
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${var.name}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
    # Static parameter; applied on next reboot.
    apply_method = "pending-reboot"
  }
}

# Master user = migrator/owner role. RDS stores its password in Secrets Manager (manage_master_user_password).
# app_user / platform_user are created by db/migrations/0001; set their real passwords after the first
# migrate (see docs/guides/runbook.md "Bootstrap a new environment") and store them in the secrets below.
resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = "16"

  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.rds.arn

  db_name                       = "procure"
  username                      = "procure_owner"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.secrets.arn

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.pg16.name

  # PITR: automated backups + WAL, restorable to any second within the retention window.
  backup_retention_period   = var.db_backup_retention_days
  backup_window             = "19:30-20:30" # 01:00-02:00 IST
  maintenance_window        = "sun:21:00-sun:22:00"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-final"

  auto_minor_version_upgrade            = true
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.rds.arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
  iam_database_authentication_enabled   = true

  lifecycle {
    ignore_changes = [final_snapshot_identifier]
  }
}

# Cross-region automated backup replication (ap-south-1 -> ap-south-2): PITR is possible in the DR region.
resource "aws_db_instance_automated_backups_replication" "dr" {
  provider               = aws.dr
  source_db_instance_arn = aws_db_instance.this.arn
  kms_key_id             = aws_kms_key.rds_dr.arn
  retention_period       = var.dr_backup_retention_days
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${var.name}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
