#!/usr/bin/env python3
"""Build release/Mixtape-Setup.exe: Electron runtime + Mixtape app (+ optional AI engine) appended to the installer stub.

Usage (from the repository root):
  python3 installer/package.py --electron desktop/.build/node_modules/electron/dist
  python3 installer/package.py --app-dir "%LOCALAPPDATA%/Programs/Mixtape"     # an already assembled app
  ... [--engine <dir with runtime/ and models/>] [--out release/Mixtape-Setup.exe]

Prerequisites: installer/dist/setup-stub.exe (bash installer/build.sh) and an Electron 44.8.0 Windows x64
runtime (node desktop/build-desktop.mjs downloads one into desktop/.build on Windows).
Only bundle --engine if you are allowed to redistribute everything in it (see docs/local-runtime.md).
"""
import argparse, io, json, os, shutil, struct, sys, tempfile, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_FILES = ['bin', 'src', 'public']
DESKTOP_FILES = ['main.cjs', 'icon.png', 'icon.ico', 'tray.png']
LEGAL_FILES = ['LICENSE', 'DISCLAIMER.md', 'THIRD_PARTY_NOTICES.md']
# Only runtime files may be reused from an installed app. Never merge its app,
# engine, settings or other user-created files into a release.
RUNTIME_FILES = {
    'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll',
    'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll',
    'libGLESv2.dll', 'LICENSE', 'LICENSES.chromium.html', 'resources.pak',
    'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version',
    'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll',
}
PRIVATE_NAMES = {
    'my-songs.json', 'config.json', 'soundcloud-client-id.json', 'library.json',
    '.mixtape-agent', '.git', 'node_modules', 'secrets', 'logs', 'cache',
}
APP_EXTENSIONS = {'.js', '.cjs', '.mjs', '.css', '.html', '.svg', '.png', '.ico', '.webp', '.woff', '.woff2'}
PRIVATE_EXTENSIONS = {'.log', '.key', '.pem', '.p12', '.pfx', '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.webm', '.mp4'}
SKIP = {'Uninstall Mixtape.exe', 'default_app.asar'}


def copy_runtime(dist, stage, executable):
    if not os.path.isfile(os.path.join(dist, executable)):
        sys.exit(f'{executable} not found in {dist} (need the Windows x64 Electron runtime)')
    os.makedirs(stage)
    shutil.copy2(os.path.join(dist, executable), os.path.join(stage, 'Mixtape.exe'))
    for name in RUNTIME_FILES:
        source = os.path.join(dist, name)
        if os.path.isfile(source):
            shutil.copy2(source, stage)
    locales = os.path.join(dist, 'locales')
    if os.path.isdir(locales):
        os.makedirs(os.path.join(stage, 'locales'))
        for name in os.listdir(locales):
            source = os.path.join(locales, name)
            if name.endswith('.pak') and os.path.isfile(source):
                shutil.copy2(source, os.path.join(stage, 'locales', name))
    for name in ('LICENSE', 'LICENSES.chromium.html'):
        if not os.path.isfile(os.path.join(stage, name)):
            sys.exit(f'Electron runtime is missing its required {name}')


def ignore_private_files(directory, names):
    return [name for name in names if
            name.lower() in PRIVATE_NAMES or name.startswith('.') or
            os.path.islink(os.path.join(directory, name)) or
            (os.path.isfile(os.path.join(directory, name)) and
             os.path.splitext(name)[1].lower() not in APP_EXTENSIONS)]


def ignore_engine_private_files(directory, names):
    private = (PRIVATE_NAMES - {'node_modules'}) | {'engine.json', 'stems', 'downloads'}
    return [name for name in names if
            name.lower() in private or name.startswith('.') or
            os.path.islink(os.path.join(directory, name)) or
            os.path.splitext(name)[1].lower() in PRIVATE_EXTENSIONS or
            name.lower().endswith('-log.txt')]


def assemble_app(stage):
    app = os.path.join(stage, 'resources', 'app')
    for d in APP_FILES:
        shutil.copytree(os.path.join(ROOT, d), os.path.join(app, d), ignore=ignore_private_files)
    os.makedirs(os.path.join(app, 'data'))
    shutil.copy2(os.path.join(ROOT, 'data', 'my-songs.example.json'), os.path.join(app, 'data'))
    os.makedirs(os.path.join(app, 'desktop'), exist_ok=True)
    for f in DESKTOP_FILES:
        shutil.copy2(os.path.join(ROOT, 'desktop', f), os.path.join(app, 'desktop', f))
    for f in LEGAL_FILES:
        shutil.copy2(os.path.join(ROOT, f), os.path.join(app, f))
    os.makedirs(os.path.join(app, 'THIRD_PARTY'))
    shutil.copy2(os.path.join(ROOT, 'installer', 'THIRD_PARTY', 'Go-LICENSE.txt'), os.path.join(app, 'THIRD_PARTY'))
    shutil.copy2(os.path.join(ROOT, 'desktop', 'icon.ico'), os.path.join(stage, 'Mixtape.ico'))


def write_app_package(stage):
    version = json.load(open(os.path.join(ROOT, 'package.json')))['version']
    pkg = {'name': 'mixtape', 'productName': 'Mixtape', 'version': version, 'type': 'module', 'main': 'desktop/main.cjs'}
    with open(os.path.join(stage, 'resources', 'app', 'package.json'), 'w') as f:
        json.dump(pkg, f, indent=2)
    return version


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument('--electron', help='Electron Windows x64 dist folder')
    src.add_argument('--app-dir', help='reuse only the runtime from an assembled Mixtape folder; app and engine are rebuilt')
    ap.add_argument('--engine', help='optional: folder with runtime/ and models/ to bundle the stem-separation AI')
    ap.add_argument('--stub', default=os.path.join(ROOT, 'installer', 'dist', 'setup-stub.exe'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'release', 'Mixtape-Setup.exe'))
    a = ap.parse_args()
    if not os.path.exists(a.stub):
        sys.exit('installer stub missing: run  bash installer/build.sh  first')

    with tempfile.TemporaryDirectory() as tmp:
        stage = os.path.join(tmp, 'Mixtape')
        if a.electron:
            copy_runtime(a.electron, stage, 'electron.exe')
            print('note: Mixtape.exe keeps the Electron icon unless you run rcedit on Windows (desktop/build-desktop.mjs does)')
        else:
            copy_runtime(a.app_dir, stage, 'Mixtape.exe')
        assemble_app(stage)
        engine_dst = os.path.join(stage, 'resources', 'app', 'engine')
        if a.engine:
            shutil.copytree(a.engine, engine_dst, ignore=ignore_engine_private_files)
        version = write_app_package(stage)

        payload = io.BytesIO()
        with zipfile.ZipFile(payload, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for base, _, files in os.walk(stage):
                for f in files:
                    if f in SKIP:
                        continue
                    p = os.path.join(base, f)
                    z.write(p, os.path.relpath(p, stage).replace(os.sep, '/'))
        main_js = 'resources/app/desktop/main.cjs'
        names = set(zipfile.ZipFile(io.BytesIO(payload.getvalue())).namelist())
        required = ['Mixtape.exe', main_js, 'resources/app/package.json', 'resources/app/src/server.js',
                    'LICENSE', 'LICENSES.chromium.html', 'resources/app/THIRD_PARTY/Go-LICENSE.txt']
        required.extend('resources/app/' + name for name in LEGAL_FILES)
        for need in required:
            if need not in names:
                sys.exit(f'payload is missing {need}')

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, 'wb') as o:
        with open(a.stub, 'rb') as f:
            shutil.copyfileobj(f, o)
        off = o.tell()
        o.write(payload.getvalue())
        o.write(struct.pack('<Q', off) + b'MIXTAPE!')
    size = os.path.getsize(a.out) / 1e6
    print(f'{a.out}  v{version}  {size:.1f} MB  ({len(names)} files)')


if __name__ == '__main__':
    main()
