variable "name" {
  description = "Stack name prefix, e.g. procure-staging"
  type        = string
}

variable "environment" {
  description = "staging | production"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "az_count" {
  type    = number
  default = 3
}

variable "single_nat_gateway" {
  description = "One NAT gateway for all AZs (cheaper, not AZ-redundant). Use false in production."
  type        = bool
  default     = false
}

# ---- domain / TLS ------------------------------------------------------------------------------
variable "acm_certificate_arn" {
  description = "ACM certificate (in the stack region) covering web_hostname and api_hostname."
  type        = string
}

variable "web_hostname" {
  type = string
}

variable "api_hostname" {
  type = string
}

# ---- database ----------------------------------------------------------------------------------
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_max_allocated_storage" {
  type    = number
  default = 500
}

variable "db_backup_retention_days" {
  type    = number
  default = 14
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

variable "dr_backup_retention_days" {
  description = "Retention for automated backups replicated to the DR region."
  type        = number
  default     = 14
}

# ---- redis -------------------------------------------------------------------------------------
variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "redis_replicas" {
  description = "Replica count (0 = single node). >=1 enables Multi-AZ automatic failover."
  type        = number
  default     = 1
}

# ---- ECS ---------------------------------------------------------------------------------------
variable "image_tag" {
  description = "Initial image tag. Deploys after bootstrap are done by .github/workflows/deploy.yml."
  type        = string
  default     = "bootstrap"
}

variable "services" {
  description = "Per-service sizing."
  type = map(object({
    cpu           = number
    memory        = number
    desired_count = number
    min_count     = number
    max_count     = number
  }))
  default = {
    api    = { cpu = 512, memory = 1024, desired_count = 2, min_count = 2, max_count = 6 }
    web    = { cpu = 512, memory = 1024, desired_count = 2, min_count = 2, max_count = 6 }
    worker = { cpu = 256, memory = 512, desired_count = 1, min_count = 1, max_count = 3 }
  }
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "alarm_email" {
  description = "Optional email subscribed to the alarm SNS topic (confirm the subscription by email)."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
