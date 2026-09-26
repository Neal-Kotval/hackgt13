# Auth staging infrastructure

This separate Terraform root creates a shared AWS hackathon app host and public CloudFront HTTPS URL for the existing Next.js/Better Auth app in account `662660921850`, Region `us-east-1`. It does not modify the GPU demo Terraform state in `infra/aws/`. Review `terraform plan` before applying. The app itself and its secrets are deployed separately.

The host is `t3.small` with standard CPU credits, a 20 GiB encrypted gp3 root volume, IMDSv2, an SSM instance profile, and a security group that admits app port 3000 only from the AWS-managed CloudFront origin-facing prefix list. An Elastic IP keeps CloudFront's EC2 origin stable across stop/start. CloudFront provides a stable AWS hostname and viewer HTTPS without a custom domain. The app binds to port 3000 on the instance; CloudFront connects to the origin over HTTP within this demo path. The application remains publicly reachable through CloudFront while EC2 is running, and Better Auth controls sign-in. This is a hackathon deployment, not production tenant isolation.

The Runpod worker requires outbound TCP 1024–65535 for direct SSH because Runpod assigns a mapped port after Pod placement. This rule grants broad outbound high-port access from this staging host; it adds no inbound access. Worker code still requires the provider-reported Pod address, dedicated SSH key, and approved host-key pin. A rule in Terraform alone does not prove the connection works; verify it from the instance against an actual Pod before marking a GPU job ready.

The private artifact bucket is encrypted with SSE-S3, blocks public access, and denies plaintext HTTP. The instance role can read only `releases/app.tar.gz` from that bucket. Deployment should write the archive there and install it via SSM into `/opt/agentcloud`, with runtime state under `/var/lib/agentcloud`. Terraform creates an empty Secrets Manager secret named `agentcloud/auth-staging/better-auth-secret` (`auth_secret_arn` output) and grants the host read access to that secret only. Populate its value separately from secure local input, such as the existing Doppler `BETTER_AUTH_SECRET`; never put secret material in Terraform state or the artifact. Terraform deletes this secret without a recovery window on destroy; back it up if needed first.

The root volume persists across stop/start. It is deleted when the instance is terminated or this Terraform root is destroyed; snapshot or migrate app state first. S3 contents are retained by `force_destroy = false` and will block destroy until deliberately emptied. The instance is initially running after apply. A systemd timer calls poweroff two hours after every boot, which AWS handles as an instance stop; verify the timer after deployment and stop the host sooner when idle. This timer is an operational backstop, not a hard spending cap. The existing account-level gross $25/month alert budget is warning-only.

Using published on-demand rates as a planning estimate, a full 730-hour month is about $15.18 for `t3.small`, $1.60 for 20 GiB gp3, $3.65 for public IPv4, and $0.40 for one Secrets Manager secret, about $20.83 before S3, data transfer, taxes, or other account charges. Verify current prices and account spend before apply; stop the host after testing to reduce compute cost.

```sh
aws sts get-caller-identity
terraform -chdir=infra/aws-auth init
terraform -chdir=infra/aws-auth plan
# Review every action and cost before apply:
terraform -chdir=infra/aws-auth apply
terraform -chdir=infra/aws-auth output
```

Terraform state is local and ignored by Git. Preserve it securely; an additional operator needs a protected shared backend and state migration before applying. Never commit state, plan files, secret values, or AWS credentials.
