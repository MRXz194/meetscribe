// AudioWorklet: chỉ đóng gói, không xử lý âm.
// AudioContext được tạo ở 16 kHz nên trình duyệt đã tự hạ mẫu (có lọc chống méo).
// Ở đây chỉ đổi float → PCM16, xếp xen kẽ các kênh (meeting, mic), gửi mỗi ~100 ms.
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions?.channels ?? 1;
    this.chunk = Math.round(sampleRate / 10);
    this.out = new Int16Array(this.chunk * this.channels);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    for (let i = 0; i < input[0].length; i++) {
      for (let c = 0; c < this.channels; c++) {
        const v = Math.max(-1, Math.min(1, (input[c] ?? input[0])[i]));
        this.out[this.filled * this.channels + c] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      if (++this.filled === this.chunk) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(this.chunk * this.channels);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
