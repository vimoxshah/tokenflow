cask "tokenflow" do
  version "1.1.1"
  sha256 "60fd7f5ce48e694af823394c63fbade8785f0ebe617fa606279e1888c7f2837c"

  url "https://github.com/vimoxshah/tokenflow/releases/download/v#{version}/TokenFlow-#{version}.dmg"
  name "TokenFlow"
  desc "Local-first AI token usage & cost analytics in your menu bar"
  homepage "https://github.com/vimoxshah/tokenflow"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "TokenFlow.app"

  # The menu-bar app is auto-relaunched by a LaunchAgent if installed; make
  # uninstall clean by stopping it first. zap removes preferences + data.
  zap trash: "~/.tokenflow"
end
