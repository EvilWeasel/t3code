{
  description = "NixOS package for the morrowbyte T3 Code fork";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/0954f7ee2f6bb3dc7d4e3d0d8bcb8fd4bde4cfc5";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = pkgs.lib;
      repositoryEnv = builtins.getEnv "T3_WEASEL_REPOSITORY";
      repository = if repositoryEnv == "" then "morrowbyte/t3code" else repositoryEnv;
      validRepository = builtins.match "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" repository != null;
      version = builtins.getEnv "T3_WEASEL_VERSION";
      artifactUrl = builtins.getEnv "T3_WEASEL_ARTIFACT_URL";
      artifactHash = builtins.getEnv "T3_WEASEL_ARTIFACT_SHA256";
      validVersion = builtins.match "[0-9A-Za-z][0-9A-Za-z.+_-]*" version != null;
      validHash = builtins.match "[0-9a-f]{64}" artifactHash != null;
      validUrl = lib.hasPrefix "https://github.com/${repository}/releases/download/v${version}/" artifactUrl;
      package = if !(validRepository && validVersion && validHash && validUrl) then
        throw "Set T3_WEASEL_VERSION, T3_WEASEL_ARTIFACT_URL and T3_WEASEL_ARTIFACT_SHA256 to verified release values"
      else
        let
          src = pkgs.fetchurl { url = artifactUrl; sha256 = artifactHash; };
          appimageContents = pkgs.appimageTools.extractType2 {
            pname = "t3code-weasel";
            inherit version src;
          };
          desktopFile = pkgs.writeText "t3code-weasel.desktop" ''
            [Desktop Entry]
            Name=T3 Code (Weasel Nightly)
            Comment=AI coding assistant desktop app
            Exec=t3code-weasel %U
            Icon=applications-development
            Terminal=false
            Type=Application
            Categories=Development;IDE;
            StartupWMClass=T3 Code
          '';
        in pkgs.stdenv.mkDerivation {
          pname = "t3code-weasel";
          inherit version;
          src = appimageContents;
          dontUnpack = true;
          dontBuild = true;
          dontWrapGApps = true;

          nativeBuildInputs = [ pkgs.autoPatchelfHook pkgs.makeWrapper pkgs.wrapGAppsHook3 ];
          buildInputs = with pkgs; [
            alsa-lib at-spi2-atk at-spi2-core cairo cups dbus dbus-glib expat
            gdk-pixbuf glib gtk3 libdrm libdbusmenu libdbusmenu-gtk3 libgbm
            libnotify libpulseaudio libsecret libxkbcommon nspr nss openssl pango
            stdenv.cc.cc.lib systemd libx11 libxcomposite libxdamage libxext
            libxfixes libxrandr libxcb
          ];
          autoPatchelfIgnoreMissingDeps = [ "libc.musl-x86_64.so.1" ];

          installPhase = ''
            runHook preInstall
            mkdir -p "$out/lib/t3code-weasel" "$out/share" "$out/libexec"
            install -m755 ${./install.sh} "$out/libexec/t3code-weasel-update.sh"
            cp -a "$src"/. "$out/lib/t3code-weasel/"
            chmod -R u+w "$out/lib/t3code-weasel"
            cp -a "$src/usr/share/icons" "$out/share/"
            install -Dm444 ${desktopFile} "$out/share/applications/t3code-weasel.desktop"
            runHook postInstall
          '';

          postFixup = ''
            makeWrapper ${pkgs.bash}/bin/bash "$out/libexec/t3code-weasel-update" \
              --add-flags "$out/libexec/t3code-weasel-update.sh" \
              --set T3_WEASEL_REPOSITORY ${lib.escapeShellArg repository} \
              --set T3_WEASEL_MANAGED 1 \
              --prefix PATH : ${lib.makeBinPath [ pkgs.coreutils pkgs.curl pkgs.jq pkgs.nix pkgs.util-linux pkgs.zstd ]}
            makeWrapper "$out/lib/t3code-weasel/t3code" "$out/bin/t3code-weasel" \
              "''${gappsWrapperArgs[@]}" \
              --prefix PATH : ${lib.makeBinPath [ pkgs.xdg-utils ]} \
              --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath (with pkgs; [
                alsa-lib at-spi2-core dbus expat glib libgbm libglvnd libpulseaudio libsecret
                libx11 libxcomposite libxdamage libxext libxfixes libxrandr
                libxcb libxkbcommon nspr nss systemd
              ])} \
              --unset NO_AT_BRIDGE \
              --add-flags "--force-renderer-accessibility" \
              --set-default T3CODE_DISABLE_AUTO_UPDATE false \
              --set T3CODE_NIX_UPDATER "$out/libexec/t3code-weasel-update" \
              --run 'export T3CODE_NIX_LAUNCHER="''${T3CODE_NIX_LAUNCHER:-''${T3CODE_DESKTOP_LINUX_URL_HANDLER_LAUNCHER:-$HOME/.local/bin/t3code-weasel}}"'
          '';

          meta = {
            description = "EvilWeasel's T3 Code fork (Weasel Nightly)";
            homepage = "https://github.com/${repository}";
            license = lib.licenses.mit;
            mainProgram = "t3code-weasel";
            platforms = [ system ];
          };
        };
    in {
      packages.${system} = {
        default = package;
        t3code-weasel = package;
      };
    };
}
