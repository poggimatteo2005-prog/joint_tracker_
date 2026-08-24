# Genera le icone PWA mancanti (standard, maskable, splash iOS) a partire da icon-512.png
# usando System.Drawing (.NET), gia' presente su Windows: non serve installare Node/Python/ImageMagick.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File generate-pwa-assets.ps1
#
# Nota: 1024x1024 e' un upscale da icon-512.png (unica sorgente disponibile), quindi sara'
# meno nitido di un export nativo da un file vettoriale/ad alta risoluzione. Se in futuro hai
# un master piu' grande (es. 1024 o SVG), rilancia lo script dopo aver sostituito icon-512.png
# con una versione a risoluzione maggiore, oppure modifica $sourcePath qui sotto.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = $PSScriptRoot
# Master full-bleed (logo a contatto coi bordi, nessun margine): tenuto separato dagli
# output icon-*.png perche' questi ultimi ora sono TUTTI generati con margine di sicurezza
# (vedi sotto) — se il source coincidesse con un output, ogni rerun dello script comprimerebbe
# il logo un po' di piu' ad ogni esecuzione.
$sourcePath = Join-Path $root 'icon-master.png'
$splashDir = Join-Path $root 'splash'
$bgColor = [System.Drawing.Color]::FromArgb(255, 0x0c, 0x12, 0x0c)  # background_color del manifest

if (-not (Test-Path $sourcePath)) { throw "Non trovo $sourcePath" }
if (-not (Test-Path $splashDir)) { New-Item -ItemType Directory -Path $splashDir | Out-Null }

$source = [System.Drawing.Image]::FromFile($sourcePath)

function New-HQGraphics($bitmap) {
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    return $g
}

# ---------- 1. Icone standard ("any", safe zone 80%, sfondo trasparente) ----------
# Erano full-bleed (logo a contatto coi bordi): Android/Play Protect applicano comunque
# una propria maschera adattiva anche alle icone "any" (non solo alle "maskable"), quindi
# senza margine il fumo/banner venivano tagliati. Sfondo trasparente (non pieno) nel
# margine, cosi' il logo non ha un riquadro colorato intorno.
function New-PlainIcon([int]$size, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = New-HQGraphics $bmp
    $g.Clear([System.Drawing.Color]::Transparent)
    $inner = [int]([math]::Round($size * 0.8))
    $offset = [int]([math]::Round(($size - $inner) / 2))
    $g.DrawImage($source, $offset, $offset, $inner, $inner)
    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "OK  $outPath"
}

New-PlainIcon 192  (Join-Path $root 'icon-192.png')
New-PlainIcon 384  (Join-Path $root 'icon-384.png')
New-PlainIcon 512  (Join-Path $root 'icon-512.png')
New-PlainIcon 1024 (Join-Path $root 'icon-1024.png')

# ---------- 2. Icone maskable (safe zone 80%, sfondo pieno) ----------
function New-MaskableIcon([int]$size, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = New-HQGraphics $bmp
    $brush = New-Object System.Drawing.SolidBrush $bgColor
    $g.FillRectangle($brush, 0, 0, $size, $size)
    $inner = [int]([math]::Round($size * 0.8))
    $offset = [int]([math]::Round(($size - $inner) / 2))
    $g.DrawImage($source, $offset, $offset, $inner, $inner)
    $g.Dispose()
    $brush.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "OK  $outPath"
}

New-MaskableIcon 192  (Join-Path $root 'icon-maskable-192.png')
New-MaskableIcon 384  (Join-Path $root 'icon-maskable-384.png')
New-MaskableIcon 512  (Join-Path $root 'icon-maskable-512.png')
New-MaskableIcon 1024 (Join-Path $root 'icon-maskable-1024.png')

# ---------- 3. Splash screen iOS (sfondo pieno, logo centrato al 35%) ----------
function New-Splash([int]$w, [int]$h, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = New-HQGraphics $bmp
    $brush = New-Object System.Drawing.SolidBrush $bgColor
    $g.FillRectangle($brush, 0, 0, $w, $h)
    $logoSize = [int]([math]::Round([math]::Min($w, $h) * 0.35))
    $x = [int]([math]::Round(($w - $logoSize) / 2))
    $y = [int]([math]::Round(($h - $logoSize) / 2))
    $g.DrawImage($source, $x, $y, $logoSize, $logoSize)
    $g.Dispose()
    $brush.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "OK  $outPath"
}

$splashSizes = @(
    @(640, 1136), @(750, 1334), @(828, 1792),
    @(1125, 2436), @(1170, 2532), @(1179, 2556), @(1242, 2688),
    @(1284, 2778), @(1290, 2796),
    @(1536, 2048), @(1620, 2160), @(1668, 2388), @(2048, 2732)
)

foreach ($s in $splashSizes) {
    $w, $h = $s
    New-Splash $w $h (Join-Path $splashDir "apple-splash-$w-$h.png")
}

$source.Dispose()
Write-Host ""
Write-Host "Fatto: 2 icone standard, 4 maskable, $($splashSizes.Count) splash iOS."
Write-Host "Ricorda: screenshot-home-narrow.png e screenshot-stats-wide.png vanno catturati a mano dall'app reale."
