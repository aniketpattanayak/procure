output "stack" {
  description = "Values to copy into the GitHub environment variables used by deploy.yml"
  value = {
    ecs_cluster             = module.stack.ecs_cluster_name
    ecr_repositories        = module.stack.ecr_repositories
    migrate_task_family     = module.stack.migrate_task_family
    migrate_subnets         = join(",", module.stack.app_subnet_ids)
    migrate_security_groups = module.stack.tasks_security_group_id
    alb_dns_name            = module.stack.alb_dns_name
    db_endpoint             = module.stack.db_endpoint
    db_master_secret_arn    = module.stack.db_master_secret_arn
    files_bucket            = module.stack.files_bucket
    alarm_topic_arn         = module.stack.alarm_topic_arn
  }
}
