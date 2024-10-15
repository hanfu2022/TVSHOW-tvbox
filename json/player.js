const loadButton = document.getElementById('loadButton');
const jsonInput = document.getElementById('jsonInput');
const channelSelect = document.getElementById('channelSelect');
const playButton = document.getElementById('playButton');
const videoPlayer = document.getElementById('videoPlayer');

// 加载频道
loadButton.addEventListener('click', async () => {
    const jsonUrl = jsonInput.value;
    if (jsonUrl) {
        try {
            const response = await fetch(jsonUrl);
            const data = await response.json();
            loadChannels(data); // 调用新函数来加载频道
        } catch (error) {
            alert('Failed to load channels: ' + error.message);
        }
    } else {
        alert('Please enter a valid JSON URL.');
    }
});

// 加载频道到下拉列表
function loadChannels(data) {
    channelSelect.innerHTML = ''; // 清空现有频道
    data.forEach(channel => {
        const option = document.createElement('option');
        option.value = channel.url; // 假设 JSON 格式为 { "url": "m3u8链接", "name": "频道名" }
        option.textContent = channel.name; // 假设 JSON 格式中包含频道名称
        channelSelect.appendChild(option);
    });
    channelSelect.style.display = 'block'; // 显示频道下拉列表
    playButton.style.display = 'block'; // 显示播放按钮
}

// 播放选择的频道
playButton.addEventListener('click', () => {
    const selectedUrl = channelSelect.value;
    if (selectedUrl) {
        loadVideo(selectedUrl);
    } else {
        alert('Please select a channel.');
    }
});

function loadVideo(url) {
    if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(url);
        hls.attachMedia(videoPlayer);
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
            videoPlayer.play();
        });
    } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
        videoPlayer.src = url;
        videoPlayer.addEventListener('loadedmetadata', function () {
            videoPlayer.play();
        });
    }
}
