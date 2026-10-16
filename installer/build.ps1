# Build the Windows installer stub without changing an installed Mixtape app.
param(
    [string]$Go = 'go',
    [Parameter(Mandatory = $true)][string]$Rcedit
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$Rcedit = (Resolve-Path -LiteralPath $Rcedit).Path
$goCommand = (Get-Command $Go -ErrorAction Stop).Source
$version = (Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a stable semantic version in package.json' }
$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$manifest = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'res/app.manifest'))
$manifest = $manifest -replace '(name="Mixtape.Setup" version=")[0-9.]+"', ('${1}' + $version + '.0"')
$manifestPath = Join-Path $dist 'app.manifest'
[IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))
function Set-MixtapeResource([string]$Path, [string]$Description, [string]$OriginalName) {
    & $Rcedit $Path --set-icon (Join-Path $root 'desktop/icon.ico') `
        --application-manifest $manifestPath --set-file-version $version --set-product-version $version `
        --set-version-string CompanyName Mixtape --set-version-string ProductName Mixtape `
        --set-version-string FileDescription $Description --set-version-string OriginalFilename $OriginalName
    if ($LASTEXITCODE -ne 0) { throw "Resource stamping failed for $Path" }
}
$saved = @{}
foreach ($name in @('GOOS','GOARCH','CGO_ENABLED')) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
Push-Location $PSScriptRoot
try {
    $env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
    $flags = "-H=windowsgui -s -w -X mixtape-installer/common.Version=$version"
    & $goCommand build -trimpath -ldflags $flags -o setup/uninstall.exe ./uninstall
    if ($LASTEXITCODE -ne 0) { throw 'Uninstaller build failed' }
    Set-MixtapeResource (Join-Path $PSScriptRoot 'setup/uninstall.exe') 'Uninstall Mixtape' 'Uninstall Mixtape.exe'
    & $goCommand vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go vet failed' }
    & $goCommand build -trimpath -ldflags $flags -o dist/setup-stub.exe ./setup
    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
    Set-MixtapeResource (Join-Path $dist 'setup-stub.exe') 'Mixtape Setup' 'Mixtape-Setup.exe'
    Write-Output "Built Mixtape $version installer stub in $dist"
} finally {
    Pop-Location
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
