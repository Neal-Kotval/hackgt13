# Private AWS authentication staging (HAC-53)

This is a **single-user staging deployment** of the existing Better Auth web app on one EC2 instance. It has no public web ingress, DNS name, or ngrok tunnel. The app listens on the instance's loopback interface; AWS Systems Manager (SSM) forwards that port to your laptop. The app's verification links use `http://127.0.0.1:3000` and work while the tunnel is open. This is not a public multi-tenant deployment, an EC2 run-box provider, or a GPU setup.

The infrastructure definition lives in [`infra/aws-auth/`](infra/aws-auth/). Terraform owns the EC2 instance, IAM policy, security group, encrypted root disk, private S3 artifact bucket, Secrets Manager secret container, and two-hour stop guard. Scripts only publish a committed application revision, put the existing secret **value** into that container, and install/restart the app on the Terraform-created host. Terraform state does not contain the secret value.

## Prerequisites and deploy

1. Use AWS CLI credentials for the intended account and Region. Install the AWS CLI Session Manager plugin, Terraform, Doppler CLI, Python 3, and Node.js locally. The deployment's `init-secret.sh` explicitly reads `BETTER_AUTH_SECRET` from `hackgt/dev_personal`; this is separate from the shared `hackgt/dev` secret selected by `doppler.yaml` for local testing. Keep the staging secret with the same persistent data directory across redeploys.
2. Review `terraform -chdir=infra/aws-auth plan` and apply it deliberately. Read `infra/aws-auth/README.md` for account, cost, and Terraform state handling. Wait for the instance to appear **Online** in SSM. The host needs outbound connectivity for SSM, S3, Secrets Manager, OS packages, and npm; its security group has no inbound rules.
3. From the repository root, run:

   ```sh
   bash scripts/aws-auth/init-secret.sh
   bash scripts/aws-auth/deploy.sh
   ```

   `init-secret.sh` copies `BETTER_AUTH_SECRET` from Doppler into AWS Secrets Manager by stdin without printing it. It preserves an existing AWS value and sessions. `deploy.sh` archives **committed `HEAD`**, uploads it to `s3://<Terraform artifact_bucket_name>/releases/app.tar.gz`, checks its SHA-256 on EC2, installs Node.js 22 and dependencies, builds Next.js, runs auth migrations, and restarts systemd. Commit all intended app changes before deploying. The deployment reports the exact Git revision and fails if SSM is offline or the local health check fails. The 2 GiB swap file supports building on `t3.small`; installation and build still need outbound package access and may take several minutes.
4. In a terminal that stays open, run:

   ```sh
   bash scripts/aws-auth/tunnel.sh
   ```

   Open `http://127.0.0.1:3000/sign-up` on that same computer. Port 3000 must be free locally because the auth origin and verification links use that exact address.

5. Sign up with your real email, then get the locally captured verification link in a separate terminal:

   ```sh
   bash scripts/aws-auth/mail-link.sh neal.kotval@gmail.com
   ```

   The command prints the latest verification URL for that email. Open it on the computer with the port 3000 tunnel, then sign in. The mail reader listens only on EC2 loopback port 3101; `mail-link.sh` uses a separate temporary SSM port-forward. SSM RunCommand output does not contain verification links. Local capture sends **no email to the inbox**. The link is sensitive and expires after one hour; avoid pasting it into logs or tickets.

`npm run auth:setup` creates the SQLite schema in `/var/lib/agentcloud/auth.sqlite`; coordination state and captured mail live under the same persistent directory. It is on the encrypted EC2 root volume and survives app restarts and EC2 stop/start, but **not termination or Terraform destroy**. Back up the directory and secret together before destroying the instance if data must be retained. The app runs as an unprivileged `agentcloud` user, binds to loopback, and has one Node.js process. The existing local-app tenant isolation limitations still apply.

## Checks and operations

Check the deployment revision and service health with the SSM command ID printed by `deploy.sh`; it also probes `http://127.0.0.1:3000/sign-in` from the instance. Through the tunnel, open `/sign-in`, sign up, verify the captured email, sign in, refresh, and sign out. A successful tunnel alone only proves transport, not authentication. The repository's browser auth test uses disposable local fixtures and does not prove the EC2 deployment.

The Terraform bootstrap stops the EC2 host after two hours. Rebooting or starting it later does not restore a local SSM tunnel; start `tunnel.sh` again. Before each use, check the host's actual state and budget. The published S3 archive, Secrets Manager secret, and root volume can continue to incur charges while the host is stopped. Destroy the Terraform staging resources when done, after saving any data needed. Avoid rotating the Better Auth secret without a planned session invalidation and data/secret recovery procedure.

At the time this staging path was designed, `t3.small` Linux compute was about $0.0209/hour in `us-east-1` (roughly $15.25 for 730 continuous hours), before EBS, public IPv4, S3, Secrets Manager, data transfer, and taxes. Terraform selects T3 **standard** credit mode, which caps CPU burst rather than charging for surplus credits. The two-hour stop guard reduces expected compute use but is not a dollar cap, and the account budget is an alert rather than enforcement. Check current pricing and the AWS billing console before extended use. A domain and ngrok are unnecessary for this private SSM access path; public sign-in would require HTTPS, real email delivery, production hardening, and a deployment design for more than one user.

**Time limit:** The AWS account's Free plan expires **2026-09-30 at 21:30 UTC**. Confirm the current account status in the billing console. If the plan ends without an upgrade, AWS may close the account and staging data may be lost; snapshot or migrate anything needed before that time. The EC2 root disk is otherwise deleted on Terraform destroy.
