vpc_cidr                 = "10.40.0.0/16"
single_nat_gateway       = true
acm_certificate_arn      = "arn:aws:acm:ap-south-1:000000000000:certificate/REPLACE-ME"
web_hostname             = "app.staging.example.com"
api_hostname             = "api.staging.example.com"
db_instance_class        = "db.t4g.medium"
db_multi_az              = true
db_backup_retention_days = 14
redis_node_type          = "cache.t4g.small"
redis_replicas           = 1
log_retention_days       = 30
alarm_email              = ""

services = {
  api    = { cpu = 512, memory = 1024, desired_count = 1, min_count = 1, max_count = 3 }
  web    = { cpu = 512, memory = 1024, desired_count = 1, min_count = 1, max_count = 3 }
  worker = { cpu = 256, memory = 512, desired_count = 1, min_count = 1, max_count = 2 }
}
