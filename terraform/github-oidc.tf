# --- GitHub Actions → Google Cloud via Workload Identity Federation ---
# Lets .github/workflows/deploy.yml push images and deploy Cloud Run without a service
# account key. Only tokens minted for var.github_repository can impersonate the deployer.

variable "github_repository" {
  description = "GitHub repository (owner/name) allowed to deploy through Workload Identity Federation"
  type        = string
  default     = "sebbycorp/qr-code-generator"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  description               = "Identity pool for GitHub Actions OIDC tokens"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.ref"              = "assertion.ref"
  }

  attribute_condition = "assertion.repository == \"${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "github_deployer" {
  account_id   = "github-deployer"
  display_name = "GitHub Actions deployer"
  description  = "Used by GitHub Actions to push images and deploy the qr-generator Cloud Run service"
}

# Allow workflows from the repository to impersonate the deployer.
resource "google_service_account_iam_member" "github_deployer_wif" {
  service_account_id = google_service_account.github_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# Push images to the app repository only.
resource "google_artifact_registry_repository_iam_member" "github_deployer_push" {
  location   = google_artifact_registry_repository.qr_app.location
  repository = google_artifact_registry_repository.qr_app.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.github_deployer.email}"
}

# Deploy new revisions of the Cloud Run service.
resource "google_project_iam_member" "github_deployer_run" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.github_deployer.email}"
}

# Deploying a revision requires acting as the service's runtime identity.
resource "google_service_account_iam_member" "github_deployer_act_as_runtime" {
  service_account_id = google_service_account.qr_generator.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deployer.email}"
}

output "github_wif_provider" {
  description = "Set as the GCP_WIF_PROVIDER repository variable in GitHub"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "github_deploy_service_account" {
  description = "Set as the GCP_DEPLOY_SA repository variable in GitHub"
  value       = google_service_account.github_deployer.email
}
