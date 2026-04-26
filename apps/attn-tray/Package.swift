// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "AttnTray",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "AttnTray",
      path: "Sources/AttnTray"
    )
  ]
)
