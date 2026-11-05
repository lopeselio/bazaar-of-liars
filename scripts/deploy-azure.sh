#!/usr/bin/env bash
# Redeploy the hosted demo: build the image in Azure Container Registry, then roll the Container App.
# One-time setup (resource group, registry, app, secrets) is described in README "Host it".
set -euo pipefail
RG=${RG:-bazaar-liars}
APP=${APP:-bazaar-liars}
ACR=${ACR:-$(az acr list -g "$RG" --query '[0].name' -o tsv)}
TAG=${TAG:-$(git rev-parse --short HEAD)}
cd "$(dirname "$0")/.."
az acr build -r "$ACR" -t "bazaar-liars:$TAG" .
az containerapp update -g "$RG" -n "$APP" --image "$ACR.azurecr.io/bazaar-liars:$TAG" -o none
echo "https://$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)/"
