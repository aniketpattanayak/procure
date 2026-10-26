data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# One CMK per concern so key policies and audit trails stay narrow.
resource "aws_kms_key" "rds" {
  description             = "${var.name} RDS storage + Performance Insights"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "rds" {
  name          = "alias/${var.name}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

resource "aws_kms_key" "rds_dr" {
  provider                = aws.dr
  description             = "${var.name} RDS automated backups replicated to DR region"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "rds_dr" {
  provider      = aws.dr
  name          = "alias/${var.name}-rds-dr"
  target_key_id = aws_kms_key.rds_dr.key_id
}

resource "aws_kms_key" "s3" {
  description             = "${var.name} file storage"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "s3" {
  name          = "alias/${var.name}-s3"
  target_key_id = aws_kms_key.s3.key_id
}

resource "aws_kms_key" "secrets" {
  description             = "${var.name} Secrets Manager + ElastiCache + logs"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${data.aws_region.current.name}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = {
          ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*" }
        }
      },
    ]
  })
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}
