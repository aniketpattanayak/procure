vpc_cidr                 = "10.50.0.0/16"
single_nat_gateway       = false
acm_certificate_arn      = "arn:aws:acm:ap-south-1:000000000000:certificate/REPLACE-ME"
web_hostname             = "app.example.com"
api_hostname             = "api.example.com"
db_instance_class        = "db.r7g.large"
db_multi_az              = true
db_backup_retention_days = 14
redis_node_type          = "cache.r7g.large"
redis_replicas           = 1
log_retention_days       = 90
alarm_email              = ""

services = {
  api    = { cpu = 1024, memory = 2048, desired_count = 3, min_count = 3, max_count = 12 }
  web    = { cpu = 512, memory = 1024, desired_count = 2, min_count = 2, max_count = 8 }
  worker = { cpu = 512, memory = 1024, desired_count = 2, min_count = 2, max_count = 6 }
}
