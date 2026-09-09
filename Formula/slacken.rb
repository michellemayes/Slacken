# A Homebrew formula for Slacken.
#
# Not in homebrew-core and not trying to be: this is here so that a tap can
# point at it —
#
#   brew tap michellemayes/slacken https://github.com/michellemayes/Slacken
#   brew install slacken
#
# — and so that the install has one description rather than one per platform.
# It installs the repository as a Node package and links the `slacken` command;
# the menu bar item is still built on first run, because it is built from
# source against whatever Swift the Mac has.
class Slacken < Formula
  desc "Calmer reading layer for the Slack desktop app, using claude -p"
  homepage "https://github.com/michellemayes/Slacken"
  url "https://github.com/michellemayes/Slacken/archive/refs/tags/v0.2.0.tar.gz"
  version "0.2.0"
  license "MIT"
  head "https://github.com/michellemayes/Slacken.git", branch: "main"

  depends_on "node" => :recommended

  def install
    system "npm", "install", "--omit=dev", "--ignore-scripts", "--prefix", buildpath
    libexec.install Dir["*"]
    (bin/"slacken").write_env_script libexec/"bin/slacken.js", PATH: "#{Formula["node"].opt_bin}:$PATH"
    chmod 0755, bin/"slacken"
  end

  def caveats
    <<~EOS
      Slacken needs the Claude Code CLI on your PATH and signed in:
        claude -p "hi"

      Then:
        slacken doctor
        slacken start

      To run it at login with no terminal:
        slacken agent install
    EOS
  end

  test do
    assert_match "slacken", shell_output("#{bin}/slacken version")
  end
end
