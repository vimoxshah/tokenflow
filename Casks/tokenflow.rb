cask "tokenflow" do
  version "1.2.0"
  sha256 "069ae03bb018b19323c96e079eaf122916765e5ac45ef59a4d622dd5d8dfed4f"

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

  # The app ships its own CLI inside the bundle, so a cask-only install is
  # complete except for Node, which macOS does not include. `depends_on
  # formula: "node"` is deliberately NOT used: it would install a second Node
  # alongside an nvm- or asdf-managed one and fight the version manager. The
  # app finds nvm, Homebrew and /usr/local installs on its own, and says so in
  # the menu bar when it finds none.
  caveats <<~EOS
    TokenFlow needs Node 22.5 or newer to read your local usage logs.
    Already have it (nvm, asdf, Homebrew)? Nothing more to do.
    Otherwise:  brew install node

    The CLI ships inside the app. For the `tokenflow` command in your shell:
      npm install -g @vimoxshah/tokenflow
  EOS

  # The menu-bar app is auto-relaunched by a LaunchAgent if installed; make
  # uninstall clean by stopping it first. zap removes preferences + data.
  zap trash: "~/.tokenflow"
end
