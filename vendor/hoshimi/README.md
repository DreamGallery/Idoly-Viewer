# Hoshimi local adapters

Only the lossless ADV CSV parser and generated Octo protobuf schema are vendored
from the sibling HoshimiToolkit working tree used by this project. They have no
network startup side effects and contain no config.ini, credentials, game account,
cache or MasterDB downloader. Keep parser changes in sync with the local export
validation workflow. Runtime Octo authentication comes from Docker environment values.
