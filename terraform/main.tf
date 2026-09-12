provider "google" {
  project = var.project_id
  region  = var.region
  # Auth: set GOOGLE_OAUTH_ACCESS_TOKEN or use application-default credentials
  # For CI/CD: use a service account key or workload identity
}

# --- Artifact Registry ---
resource "google_artifact_registry_repository" "qr_app" {
  location      = var.region
  repository_id = "qr-app"
  format        = "DOCKER"
  description   = "Docker repository for QR code generator"
}

# --- Firestore for durable short-link storage ---
resource "google_firestore_database" "default" {
  project                     = var.project_id
  name                        = "(default)"
  location_id                 = var.firestore_location
  type                        = "FIRESTORE_NATIVE"
  concurrency_mode            = "OPTIMISTIC"
  app_engine_integration_mode = "DISABLED"
  delete_protection_state     = "DELETE_PROTECTION_ENABLED"
}

# --- Runtime identity ---
resource "google_service_account" "qr_generator" {
  account_id   = "qr-generator-sa"
  display_name = "QR Generator runtime"
}

resource "google_project_iam_member" "firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.qr_generator.email}"
}

# --- Cloud Run Service ---
resource "google_cloud_run_service" "qr_generator" {
  name     = "qr-generator"
  location = var.region

  metadata {
    annotations = {
      "run.googleapis.com/ingress" = "all"
    }
  }

  template {
    metadata {
      annotations = {
        "autoscaling.knative.dev/minScale" = "0"
        "autoscaling.knative.dev/maxScale" = "3"
      }
    }

    spec {
      service_account_name  = google_service_account.qr_generator.email
      container_concurrency = 80

      containers {
        image = var.image

        env {
          name  = "SHORT_STORAGE"
          value = "firestore"
        }

        env {
          name  = "SHORT_BASE_URL"
          value = "https://${var.short_domain}"
        }

        env {
          name  = "FIRESTORE_COLLECTION"
          value = "short_links"
        }

        ports {
          container_port = 4242
        }

        resources {
          limits = {
            memory = "128Mi"
            cpu    = "1"
          }
        }
      }
    }
  }

  traffic {
    percent         = 100
    latest_revision = true
  }

  depends_on = [
    google_firestore_database.default,
    google_project_iam_member.firestore_user,
  ]

  lifecycle {
    # GitHub Actions (see .github/workflows/deploy.yml) rolls out new images with
    # `gcloud run deploy`. Ignore the fields it manages so `terraform apply` never
    # rolls a deployment back to var.image.
    ignore_changes = [
      metadata[0].annotations["run.googleapis.com/operation-id"],
      metadata[0].annotations["run.googleapis.com/client-name"],
      metadata[0].annotations["run.googleapis.com/client-version"],
      template[0].metadata[0].name,
      template[0].metadata[0].annotations["run.googleapis.com/client-name"],
      template[0].metadata[0].annotations["run.googleapis.com/client-version"],
      template[0].metadata[0].annotations["client.knative.dev/user-image"],
      template[0].spec[0].containers[0].image,
    ]
  }
}

# --- IAM: Allow unauthenticated access ---
resource "google_cloud_run_service_iam_member" "public" {
  location = google_cloud_run_service.qr_generator.location
  service  = google_cloud_run_service.qr_generator.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Cloud Run Domain Mappings ---
resource "google_cloud_run_domain_mapping" "app_domain" {
  name     = var.app_domain
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_service.qr_generator.name
  }
}

resource "google_cloud_run_domain_mapping" "short_domain" {
  name     = var.short_domain
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_service.qr_generator.name
  }
}

# --- Cloud DNS CNAME records in maniak-io project ---
resource "google_dns_record_set" "app_cname" {
  project      = var.dns_project_id
  managed_zone = var.dns_zone_name
  name         = "${var.app_domain}."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = ["ghs.googlehosted.com."]
}

resource "google_dns_record_set" "short_cname" {
  project      = var.dns_project_id
  managed_zone = var.dns_zone_name
  name         = "${var.short_domain}."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = ["ghs.googlehosted.com."]
}
