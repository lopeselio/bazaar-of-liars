#!/usr/bin/env bash
# Redeploy the hosted demo: build the image in Azure Container Registry, then roll the Container App.
# One-time setup (resource group, registry, app, secrets) is described in README "Host it".
set -euo pipefail
RG=${RG:-bazaar-liars}
APP=${APP:-bazaar-liars}
ACR=${ACR:-$(az acr list -g "$RG" --query '[0].name' -o tsv)}
TAG=${TAG:-$(git rev-parse --short HEAD)}
cd "$(dirname "$0")/.."
az acr build -r "$ACR" -t "bazaar-liars:$TAG" --build-arg "APP_VERSION=$TAG" .
az containerapp update -g "$RG" -n "$APP" --image "$ACR.azurecr.io/bazaar-liars:$TAG" -o none
URL="https://$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)"
# Wait until the new image answers /api/health (old replicas keep serving until then).
for i in $(seq 1 40); do
  if curl -fsS --max-time 10 "$URL/api/health" 2>/dev/null | grep -q "\"version\":\"$TAG\""; then echo "$URL/ is live on $TAG"; exit 0; fi
  sleep 6
done
echo "the new revision didn't report $TAG on /api/health within 4 minutes; check: az containerapp logs show -g $RG -n $APP" >&2
exit 1
