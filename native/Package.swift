// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AyaNative",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    ],
    targets: [
        .target(name: "AyaKit"),
        .executableTarget(
            name: "AyaNative",
            dependencies: [
                "AyaKit",
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ]
        ),
        .testTarget(name: "AyaKitTests", dependencies: ["AyaKit"]),
    ]
)
