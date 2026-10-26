output "vpc_id" {
  value = aws_vpc.this.id
}

output "app_subnet_ids" {
  description = "Private subnets for ECS tasks (MIGRATE_SUBNETS in deploy.yml)"
  value       = aws_subnet.app[*].id
}

output "tasks_security_group_id" {
  description = "MIGRATE_SECURITY_GROUPS in deploy.yml"
  value       = aws_security_group.tasks.id
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_zone_id" {
  value = aws_lb.this.zone_id
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "migrate_task_family" {
  value = aws_ecs_task_definition.migrate.family
}

output "db_endpoint" {
  value = aws_db_instance.this.address
}

output "db_master_secret_arn" {
  value = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "files_bucket" {
  value = aws_s3_bucket.files.bucket
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
