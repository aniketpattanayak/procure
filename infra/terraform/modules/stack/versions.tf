terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 5.80"
      configuration_aliases = [aws.dr]
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
