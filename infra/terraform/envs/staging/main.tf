terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State bucket + lock table are created once per account (bootstrap, outside this repo).
  # Pass values with: terraform init -backend-config=backend.hcl
  backend "s3" {
    key     = "procure/staging/terraform.tfstate"
    region  = "ap-south-1"
    encrypt = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "procure"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

# Disaster-recovery region for cross-region automated backup replication.
provider "aws" {
  alias  = "dr"
  region = var.dr_region
  default_tags {
    tags = {
      Project     = "procure"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

module "stack" {
  source = "../../modules/stack"
  providers = {
    aws    = aws
    aws.dr = aws.dr
  }

  name                     = "procure-staging"
  environment              = "staging"
  vpc_cidr                 = var.vpc_cidr
  single_nat_gateway       = var.single_nat_gateway
  acm_certificate_arn      = var.acm_certificate_arn
  web_hostname             = var.web_hostname
  api_hostname             = var.api_hostname
  db_instance_class        = var.db_instance_class
  db_multi_az              = var.db_multi_az
  db_backup_retention_days = var.db_backup_retention_days
  db_deletion_protection   = true
  redis_node_type          = var.redis_node_type
  redis_replicas           = var.redis_replicas
  services                 = var.services
  log_retention_days       = var.log_retention_days
  alarm_email              = var.alarm_email
}
