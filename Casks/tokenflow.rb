cask "tokenflow" do
  version "1.4.0"
  sha256 "db09d041611fd93db02eeb18e4b919e8438d73e98fd6950281efc167820e5522"

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

    TokenFlow has no Dock icon — look for TF in the menu bar. The first launch
    opens its panel so you can find it, and adds TokenFlow to Login Items.
    Turn that off in System Settings > General > Login Items.
  EOS

  # Two LaunchAgents may exist once the app has run: app.tokenflow.watch (the
  # watcher, RunAtLoad) and app.tokenflow.digest (scheduled digests). Neither
  # launches the app itself — since 1.4.0 the app registers its own login item
  # through SMAppService, which lives in the system's background-task database
  # and is removed by macOS with the bundle, not by anything listed here. What
  # zap does remove is the data, the two agents, and the defaults holding the
  # once-only first-launch flags.
  zap trash: [
    "~/.tokenflow",
    "~/Library/LaunchAgents/app.tokenflow.watch.plist",
    "~/Library/LaunchAgents/app.tokenflow.digest.plist",
    "~/Library/Preferences/app.tokenflow.bar.plist",
  ]
end
