# Security acceptance checklist

Before demo: no real customer data; HTTPS only; MFA-protected AWS; private S3; demo URL banner; tested deletion/reset of demo data.

Before production: separate account; GitHub production approval; Cognito JWT authorizer attached to API Gateway (the starter route intentionally needs this completed); private RDS with Secrets Manager; RLS integration tests; WAF; CloudTrail/GuardDuty/Security Hub; budget alarms; backup restore evidence; external penetration test; incident contacts/runbook; retention/privacy review; rule-content approval trail.

The CDK file is intentionally a foundation rather than a claim of completed production compliance. Add the VPC/RDS/WAF/JWT authorizer stacks before customer data enters it; their setup depends on the selected AWS account/region/domain and must be reviewed from an account with actual AWS permissions.
