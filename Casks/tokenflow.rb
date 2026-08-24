cask "tokenflow" do
  version "1.1.0"
  sha256 "e560ff35518a0a4033564dc67eb19e4faec0eee6ead09ebd0bd71a6115e07cc8"

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
