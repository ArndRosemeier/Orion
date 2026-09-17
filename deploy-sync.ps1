# Orion - incremental FTP sync to futuremagic.de
#
# Builds with the subdirectory Vite base, uploads only new/changed files
# (by size), and removes remote files that are no longer in dist/.
#
# Usage (from repo root):
#   .\deploy-sync.bat
#   .\deploy-sync.ps1
#   pnpm run deploy:sync
#
# Password: $env:FTP_PASSWORD, or User env FTP_PASSWORD, or interactive prompt.

param(
    [string]$FtpServer = "ftp.futuremagic.de",
    [string]$FtpUser = "12529-Pyrion",
    [string]$RemotePath = "/webseiten/Orion/",
    [string]$BasePath = "/Orion/",
    [string]$PublicUrl = "https://futuremagic.de/Orion/",
    [string]$Slug = "Orion",
    [string]$Title = "Orion"
)

$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
Set-Location $RepoRoot

function Normalize-FtpDir([string]$path) {
    $p = $path.Replace('\', '/')
    if (-not $p.StartsWith('/')) { $p = "/$p" }
    if (-not $p.EndsWith('/')) { $p = "$p/" }
    return $p
}

function Normalize-WebBase([string]$path) {
    $p = $path.Replace('\', '/')
    if (-not $p.StartsWith('/')) { $p = "/$p" }
    if (-not $p.EndsWith('/')) { $p = "$p/" }
    return $p
}

function Get-FtpPassword {
    $password = $env:FTP_PASSWORD
    if (-not $password) {
        try {
            $password = [Environment]::GetEnvironmentVariable("FTP_PASSWORD", "User")
            if ($password) {
                Write-Host "Retrieved password from user environment variables" -ForegroundColor Green
                $env:FTP_PASSWORD = $password
            }
        } catch {
            # Ignore errors
        }
    }
    if (-not $password) {
        Write-Host "Enter FTP password:" -ForegroundColor Yellow
        $secure = Read-Host -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $password = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    } else {
        Write-Host "Using stored password" -ForegroundColor Green
    }
    if (-not $password) {
        throw "FTP password is required"
    }
    return $password
}

function New-FtpRequest([string]$uri, [string]$method, [string]$password) {
    $request = [System.Net.FtpWebRequest]::Create($uri)
    $request.Method = $method
    $request.Credentials = New-Object System.Net.NetworkCredential($FtpUser, $password)
    $request.UseBinary = $true
    $request.UsePassive = $true
    $request.Timeout = 300000
    return $request
}

function Ensure-FtpDirectory([string]$remoteDir, [string]$password) {
    try {
        $request = New-FtpRequest "ftp://$FtpServer$remoteDir" ([System.Net.WebRequestMethods+Ftp]::MakeDirectory) $password
        $response = $request.GetResponse()
        $response.Close()
        Write-Host "Created directory: $remoteDir" -ForegroundColor Blue
    } catch {
        # Already exists
    }
}

function Get-FtpFileSize([string]$remoteFile, [string]$password) {
    try {
        $request = New-FtpRequest "ftp://$FtpServer$remoteFile" ([System.Net.WebRequestMethods+Ftp]::GetFileSize) $password
        $response = $request.GetResponse()
        $size = $response.ContentLength
        $response.Close()
        return [int64]$size
    } catch {
        return $null
    }
}

function Upload-FtpFile([string]$localPath, [string]$remoteFile, [string]$password) {
    $bytes = [System.IO.File]::ReadAllBytes($localPath)
    $request = New-FtpRequest "ftp://$FtpServer$remoteFile" ([System.Net.WebRequestMethods+Ftp]::UploadFile) $password
    $request.ContentLength = $bytes.Length
    $stream = $request.GetRequestStream()
    try {
        $stream.Write($bytes, 0, $bytes.Length)
    } finally {
        $stream.Close()
    }
    $response = $request.GetResponse()
    $response.Close()
    return $bytes.Length
}

function Remove-FtpFile([string]$remoteFile, [string]$password) {
    $request = New-FtpRequest "ftp://$FtpServer$remoteFile" ([System.Net.WebRequestMethods+Ftp]::DeleteFile) $password
    $response = $request.GetResponse()
    $response.Close()
}

function Get-FtpListingLines([string]$remoteDir, [string]$password) {
    $request = New-FtpRequest "ftp://$FtpServer$remoteDir" ([System.Net.WebRequestMethods+Ftp]::ListDirectoryDetails) $password
    $response = $request.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try {
            $listing = $reader.ReadToEnd()
        } finally {
            $reader.Close()
        }
    } finally {
        $response.Close()
    }
    return $listing.Split([Environment]::NewLine, [StringSplitOptions]::RemoveEmptyEntries)
}

function Get-FtpEntryName([string]$line) {
    $parts = $line.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)
    if ($parts.Length -eq 0) {
        return $null
    }
    return $parts[-1]
}

function Test-FtpListingIsDirectory([string]$line) {
    return $line.StartsWith("d") -or ($line -match "<DIR>")
}

function Get-FtpRemoteFiles([string]$remoteDir, [string]$password, [string]$prefix = "") {
    $files = @{}
    try {
        $lines = Get-FtpListingLines $remoteDir $password
    } catch {
        return $files
    }
    foreach ($line in $lines) {
        if (-not $line.Trim() -or $line.StartsWith("total")) {
            continue
        }
        $name = Get-FtpEntryName $line
        if (-not $name -or $name -eq "." -or $name -eq "..") {
            continue
        }
        $rel = if ($prefix.Length -eq 0) { $name } else { "$prefix/$name" }
        if (Test-FtpListingIsDirectory $line) {
            $child = Get-FtpRemoteFiles "$remoteDir$name/" $password $rel
            foreach ($key in $child.Keys) {
                $files[$key] = $child[$key]
            }
        } else {
            $size = Get-FtpFileSize "$remoteDir$name" $password
            if ($null -eq $size) {
                $size = -1
            }
            $files[$rel] = [int64]$size
        }
    }
    return $files
}

$RemotePath = Normalize-FtpDir $RemotePath
$BasePath = Normalize-WebBase $BasePath
$RegisterScript = "C:\Projekte\Futuremagic\scripts\Register-FuturemagicApp.ps1"
$AlwaysUpload = @("index.html", ".htaccess", "futuremagic.json")

Write-Host "Starting DIFF SYNC Orion deployment..." -ForegroundColor Cyan
Write-Host "Remote is not wiped - only new/changed files upload; stale remote files are removed." -ForegroundColor Yellow
Write-Host "Vite base: $BasePath" -ForegroundColor Cyan
Write-Host "Public URL: $PublicUrl" -ForegroundColor Cyan

try {
    Write-Host "Cleaning build folder..." -ForegroundColor Yellow
    if (Test-Path "dist") {
        Remove-Item -Recurse -Force "dist"
    }

    Write-Host "Building application for domainfactory..." -ForegroundColor Yellow
    $env:ORION_BASE = $BasePath
    pnpm run build:domainfactory
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm run build:domainfactory failed with exit code $LASTEXITCODE"
    }

    Write-Host "Copying .htaccess..." -ForegroundColor Yellow
    if (-not (Test-Path "public\.htaccess")) {
        throw "public/.htaccess is missing"
    }
    Copy-Item "public\.htaccess" "dist\.htaccess" -Force
    $htaccessPath = Join-Path $RepoRoot "dist\.htaccess"
    $htaccessBody = [System.IO.File]::ReadAllText($htaccessPath)
    $htaccessBody = $htaccessBody -replace '(?m)^(\s*RewriteBase\s+)\S+', "`${1}$BasePath"
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($htaccessPath, $htaccessBody.TrimStart([char]0xFEFF), $utf8NoBom)

    if (Test-Path "public\futuremagic.json") {
        Copy-Item "public\futuremagic.json" "dist\futuremagic.json" -Force
    }

    if (-not (Test-Path "dist\index.html")) {
        throw "Build failed - no index.html found"
    }
    if (-not (Test-Path "dist\shot.png")) {
        Write-Host "Warning: dist/shot.png is missing, so the site's card will have no image." -ForegroundColor Yellow
        Write-Host "  Generate it with: pnpm run screenshot" -ForegroundColor Yellow
    }

    Write-Host "Build successful!" -ForegroundColor Green

    $FTP_PASSWORD = Get-FtpPassword

    Ensure-FtpDirectory $RemotePath $FTP_PASSWORD

    Write-Host "Listing remote files for comparison..." -ForegroundColor Yellow
    $remoteFiles = Get-FtpRemoteFiles $RemotePath $FTP_PASSWORD
    Write-Host ("Remote currently has {0} file(s)." -f $remoteFiles.Count) -ForegroundColor Cyan

    $distRoot = (Resolve-Path "dist").Path
    $localFiles = Get-ChildItem -Path "dist" -Recurse -File
    $localMap = @{}
    foreach ($file in $localFiles) {
        $rel = $file.FullName.Substring($distRoot.Length + 1).Replace('\', '/')
        $localMap[$rel] = $file
    }

    $uploaded = 0
    $skipped = 0
    $deleted = 0
    $failed = @()

    Write-Host "Syncing local dist/ to remote..." -ForegroundColor Green
    foreach ($rel in ($localMap.Keys | Sort-Object)) {
        $file = $localMap[$rel]
        $remoteFile = "$RemotePath$rel"
        $force = $AlwaysUpload -contains $rel
        $remoteSize = if ($remoteFiles.ContainsKey($rel)) { $remoteFiles[$rel] } else { $null }
        $localSize = [int64]$file.Length

        if (-not $force -and $null -ne $remoteSize -and $remoteSize -eq $localSize) {
            $skipped++
            Write-Host "Skip (same size): $rel" -ForegroundColor DarkGray
            continue
        }

        $pathParts = $rel.Split('/')
        if ($pathParts.Length -gt 1) {
            $currentPath = $RemotePath
            for ($i = 0; $i -lt ($pathParts.Length - 1); $i++) {
                $currentPath = "$currentPath$($pathParts[$i])/"
                Ensure-FtpDirectory $currentPath $FTP_PASSWORD
            }
        }

        try {
            $bytes = Upload-FtpFile $file.FullName $remoteFile $FTP_PASSWORD
            $uploaded++
            $reason = if ($force) { "always" } elseif ($null -eq $remoteSize) { "new" } else { "changed" }
            $sizeKB = [math]::Round($bytes / 1KB, 1)
            Write-Host ('Uploaded ({0}): {1} ({2} KB)' -f $reason, $rel, $sizeKB) -ForegroundColor Green
        } catch {
            $failed += $rel
            Write-Host ('Failed: {0} - {1}' -f $rel, $_.Exception.Message) -ForegroundColor Red
        }
    }

    Write-Host "Removing stale remote files..." -ForegroundColor Yellow
    foreach ($rel in ($remoteFiles.Keys | Sort-Object)) {
        if ($localMap.ContainsKey($rel)) {
            continue
        }
        try {
            Remove-FtpFile "$RemotePath$rel" $FTP_PASSWORD
            $deleted++
            Write-Host ('Deleted stale: {0}' -f $rel) -ForegroundColor DarkYellow
        } catch {
            $failed += $rel
            Write-Host ('Failed delete: {0} - {1}' -f $rel, $_.Exception.Message) -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host "=== DEPLOYMENT VERIFICATION ===" -ForegroundColor Cyan
    foreach ($criticalFile in @("index.html", ".htaccess")) {
        try {
            $size = Get-FtpFileSize "$RemotePath$criticalFile" $FTP_PASSWORD
            if ($null -eq $size) {
                throw "missing"
            }
            Write-Host ('[OK] {0} verified ({1} bytes)' -f $criticalFile, $size) -ForegroundColor Green
        } catch {
            Write-Host ('[FAIL] {0} MISSING!' -f $criticalFile) -ForegroundColor Red
            $failed += $criticalFile
        }
    }

    if ($failed.Count -gt 0) {
        Write-Host ""
        Write-Host "=== FAILED OPERATIONS ===" -ForegroundColor Red
        foreach ($failedFile in $failed) {
            Write-Host ('[FAIL] {0}' -f $failedFile) -ForegroundColor Red
        }
        throw ('Sync completed with {0} failed operation(s). Check the errors above.' -f $failed.Count)
    }

    Write-Host ""
    Write-Host ('DIFF SYNC finished! Uploaded {0}, skipped {1}, deleted {2}.' -f $uploaded, $skipped, $deleted) -ForegroundColor Green
    Write-Host ('App should now work at: {0}' -f $PublicUrl) -ForegroundColor Cyan

    if (Test-Path $RegisterScript) {
        Write-Host ""
        & $RegisterScript `
            -Slug $Slug `
            -Title $Title `
            -Path $BasePath `
            -FtpPassword $FTP_PASSWORD `
            -ManifestoLocalPath (Join-Path $RepoRoot "dist\futuremagic.json") `
            -AppRemoteDir $RemotePath
    } else {
        Write-Host ('[SKIP] Futuremagic registry helper not found: {0}' -f $RegisterScript) -ForegroundColor Yellow
    }
} catch {
    Write-Host ('Deployment failed: {0}' -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}
