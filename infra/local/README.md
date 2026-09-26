# Local backend with Terraform

This independent Terraform root describes the real AgentCloud backend in one local Docker container. It has only the Docker provider: no AWS provider, cloud credentials, remote backend, provisioners, GPU emulator, or fabricated agent activity. It does not validate EC2, IAM, SSM, networking, or remote execution. The root Docker Compose workflow is the recommended way to run the local simulation; this root provides an alternative infrastructure description to inspect and plan.

## Inspect without starting anything

Install Terraform 1.6 or newer (below 2.0) and run a local Docker engine. From the repository root:

```sh
terraform -chdir=infra/local init
terraform -chdir=infra/local fmt -check
terraform -chdir=infra/local validate
terraform -chdir=infra/local plan
```

`init` downloads the pinned Docker provider. `validate` checks configuration, and `plan` connects to the local engine and previews resources; neither builds the image nor starts containers. This simulation workflow does not run `terraform apply`, touch either AWS Terraform root, or deploy anything to AWS.

The provider defaults to `unix:///var/run/docker.sock`. If Docker Desktop uses another socket, inspect it with `docker context inspect --format '{{.Endpoints.docker.Host}}'` and pass that local Unix socket explicitly:

```sh
terraform -chdir=infra/local plan -var='docker_host=unix:///Users/YOUR_USER/.docker/run/docker.sock'
```

Only local Unix sockets are accepted. Changing `DOCKER_HOST` does not override the explicit provider setting. The default endpoint is `http://127.0.0.1:3002`; use `-var='port=3003'` when that port is occupied. Use the same variables for subsequent operations. Both the Docker port binding and Better Auth URL follow this value.

## Resource and persistence contract

If deliberately applied later, the configuration builds the repository's root Dockerfile as `agentcloud-backend:local` and starts `agentcloud-terraform-local-backend`. Source changes trigger an image rebuild. The image runs as `node` and prepares `/data` ownership; Docker initializes the fresh named volume from that directory. Startup creates and privately retains the authentication secret inside `/data`, outside Terraform variables, outputs and state. No environment file or AWS credentials are mounted.

The dedicated `agentcloud-terraform-local-data` volume stores auth SQLite data, coordination records and local captured email. Fresh storage starts empty. Container restarts and replacements reuse it. This is distinct from the Compose volume: switching between workflows creates separate local identities and records. Do not give Terraform ownership of the Compose volume or run both on the same host port. The image is shared and retained when its Terraform resource is removed.

The volume has `prevent_destroy = true`, so a full Terraform destroy refuses to delete persistent data. Stop the container without deleting records using `docker stop agentcloud-terraform-local-backend`; resume it with `docker start agentcloud-terraform-local-backend`. An intentional full reset requires backing up any needed records and explicitly removing the volume's lifecycle guard before reviewing a destructive plan. Deleting the volume also deletes the private auth secret and local captured messages.

Terraform state and plans are ignored by Git. Keep them private even though this root never supplies an application secret to Terraform. Local mail remains inside the private data volume; registration and verification are real backend operations, not seeded demo identities. HTTP loopback access is for this local development demonstration, not a public multi-user deployment.
