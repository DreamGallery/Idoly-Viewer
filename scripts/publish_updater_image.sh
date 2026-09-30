#!/bin/sh
# Builds target-platform decoder and Python dependencies inside the image.
set -eu
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 dockerhub-user/repository version [linux/amd64,linux/arm64]" >&2
    exit 2
fi
image=$1
version=$2
platforms=${3:-linux/amd64}
mirror=${IDOLY_DEBIAN_MIRROR:-https://deb.debian.org}
pip_index=${IDOLY_PIP_INDEX_URL:-https://pypi.org/simple}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
docker info >/dev/null
docker buildx version >/dev/null
if ! docker buildx inspect idoly-builder >/dev/null 2>&1; then
    docker buildx create --name idoly-builder --driver docker-container >/dev/null
fi
docker buildx inspect idoly-builder --bootstrap
# Check each target image before publishing the multi-platform manifest.
for platform in $(printf '%s' "$platforms" | tr ',' ' '); do
    local_tag="$image:$version-check-$(printf '%s' "$platform" | tr '/' '-')"
    docker buildx build --builder idoly-builder --platform "$platform" \
        --build-arg "DEBIAN_MIRROR=$mirror" --build-arg "PIP_INDEX_URL=$pip_index" --file "$root/docker/Dockerfile.updater" --tag "$local_tag" --load "$root"
    sh "$root/scripts/check_updater_image.sh" "$local_tag" "$platform"
done
docker buildx build --builder idoly-builder --platform "$platforms" \
    --build-arg "DEBIAN_MIRROR=$mirror" --build-arg "PIP_INDEX_URL=$pip_index" --file "$root/docker/Dockerfile.updater" \
    --tag "$image:$version" --push "$root"
docker buildx imagetools inspect "$image:$version"
