let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

document.getElementById("installButton").addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    alert("请通过浏览器菜单选择“安装应用”或“添加到主屏幕”。");
    return;
  }

  deferredInstallPrompt.prompt();

  const choice = await deferredInstallPrompt.userChoice;

  if (choice.outcome === "accepted") {
    alert("已确认安装，请等待安装完成，然后从桌面图标打开应用。");
  }

  deferredInstallPrompt = null;
});

const $ = (id) => document.getElementById(id);

const installGate = $("installGate");
const scannerPanel = $("scannerPanel");
const modeBadge = $("modeBadge");
const installButton = $("installButton");
const installHelp = $("installHelp");
const gateTitle = $("gateTitle");
const gateDescription = $("gateDescription");
let deferredInstallPrompt = null;
let scanner = null;
let scanning = false;
let currentResult = "";

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isAndroid() {
  return /android/i.test(navigator.userAgent);
}

function showGate() {
  installGate.hidden = false;
  scannerPanel.hidden = true;
  modeBadge.textContent = "浏览器模式";
  gateTitle.textContent = "请从手机桌面启动";
  gateDescription.textContent = "当前页面不是以已安装的独立应用模式运行。请先添加到主屏幕，再关闭浏览器页面，从桌面图标重新打开。扫码功能目前已锁定。";

  if (deferredInstallPrompt) {
    installButton.hidden = false;
    installHelp.textContent = "你的浏览器支持直接安装。点击下方按钮，然后在系统弹窗中确认安装。安装完成后，请回到桌面点击应用图标。";
  } else {
    installButton.hidden = true;
    if (isIOS()) {
      installHelp.innerHTML = "在 iPhone / iPad 上：<b>用 Safari 打开此页面</b> → 点击“分享”图标 → 选择“添加到主屏幕” → 点击“添加”。然后回到主屏幕，从新图标打开。";
    } else if (isAndroid()) {
      installHelp.innerHTML = "在 Android 上：打开浏览器菜单（通常是右上角 ⋮）→ 选择“安装应用”或“添加到主屏幕”。如果没有安装选项，请尝试 Chrome，并确认网站使用 HTTPS。";
    } else {
      installHelp.textContent = "请使用手机浏览器访问此网站，并通过浏览器菜单将其添加到主屏幕。桌面浏览器预览不能解锁扫码功能。";
    }
  }
}

function showScanner() {
  installGate.hidden = true;
  scannerPanel.hidden = false;
  modeBadge.textContent = "独立应用模式";
  $("scanStatus").textContent = "已从独立应用模式启动。点击“开启摄像头”开始扫码。";
}

function updateAccess() {
  if (isStandalone()) {
    showScanner();
  } else {
    showGate();
  }
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (!isStandalone()) showGate();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installButton.hidden = true;
  installHelp.textContent = "安装事件已确认。请返回手机桌面，点击应用图标重新打开。";
});

installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installButton.hidden = true;
  installHelp.textContent = "请完成系统安装提示，然后回到手机桌面点击应用图标。当前浏览器标签页不会自动解锁扫码功能。";
});

$("recheckButton").addEventListener("click", updateAccess);

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}

function onScanSuccess(decodedText) {
  currentResult = decodedText;
  $("scanResult").textContent = decodedText;
  $("resultBox").hidden = false;
  $("scanStatus").textContent = "识别成功。可以复制结果，或在结果是 HTTP/HTTPS 链接时打开。";
  const validUrl = /^https?:\/\/\S+$/i.test(decodedText);
  $("openResultButton").hidden = !validUrl;
  $("openResultButton").onclick = () => {
    if (validUrl) window.open(decodedText, "_blank", "noopener,noreferrer");
  };
  stopScanner();
}

async function startScanner() {
  if (!isStandalone()) {
    updateAccess();
    return;
  }
  if (!window.Html5Qrcode) {
    $("scanStatus").textContent = "扫码组件加载失败。请检查网络连接后刷新页面。";
    return;
  }
  if (scanning) return;

  scanner = new Html5Qrcode("reader");
  $("startScanButton").disabled = true;
  $("scanStatus").textContent = "正在请求摄像头权限…";
  try {
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: (width, height) => {
          const size = Math.floor(Math.min(width, height) * 0.72);
          return { width: size, height: size };
        } },
      onScanSuccess,
      () => {}
    );
    scanning = true;
    $("stopScanButton").disabled = false;
    $("scanStatus").textContent = "摄像头已开启，请将二维码放入取景框。";
  } catch (err) {
    scanner = null;
    $("scanStatus").textContent = "无法开启摄像头。请确认使用 HTTPS、允许相机权限，并关闭其他正在使用相机的应用。";
    console.error(err);
  } finally {
    $("startScanButton").disabled = false;
  }
}

async function stopScanner() {
  if (!scanner || !scanning) {
    $("stopScanButton").disabled = true;
    return;
  }
  try {
    await scanner.stop();
    await scanner.clear();
  } catch (err) {
    console.warn("Scanner stop:", err);
  }
  scanner = null;
  scanning = false;
  $("stopScanButton").disabled = true;
  $("startScanButton").disabled = false;
}

$("startScanButton").addEventListener("click", startScanner);
$("stopScanButton").addEventListener("click", stopScanner);
$("copyResultButton").addEventListener("click", async () => {
  if (!currentResult) return;
  try {
    await navigator.clipboard.writeText(currentResult);
    $("scanStatus").textContent = "已复制到剪贴板。";
  } catch {
    $("scanStatus").textContent = "复制失败，请长按识别结果手动复制。";
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && scanning) stopScanner();
});
window.addEventListener("pageshow", updateAccess);
window.addEventListener("DOMContentLoaded", updateAccess);
updateAccess();
