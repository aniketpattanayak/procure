variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "dr_region" {
  type    = string
  default = "ap-south-2"
}

variable "vpc_cidr" {
  type = string
}

variable "single_nat_gateway" {
  type = bool
}

variable "acm_certificate_arn" {
  type = string
}

variable "web_hostname" {
  type = string
}

variable "api_hostname" {
  type = string
}

variable "db_instance_class" {
  type = string
}

variable "db_multi_az" {
  type = bool
}

variable "db_backup_retention_days" {
  type = number
}

variable "redis_node_type" {
  type = string
}

variable "redis_replicas" {
  type = number
}

variable "services" {
  type = map(object({
    cpu           = number
    memory        = number
    desired_count = number
    min_count     = number
    max_count     = number
  }))
}

variable "log_retention_days" {
  type = number
}

variable "alarm_email" {
  type    = string
  default = ""
}
