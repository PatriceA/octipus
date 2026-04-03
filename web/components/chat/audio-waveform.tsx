'use client';

import { useEffect, useRef } from 'react';

interface AudioWaveformProps {
  stream: MediaStream;
  className?: string;
}

/**
 * Real-time audio waveform visualization using Web Audio API AnalyserNode.
 * Shows a mini sound wave that responds to voice input.
 */
export function AudioWaveform({ stream, className }: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const barCount = 24;
      const barWidth = Math.max(2, (w / barCount) - 1);
      const gap = 1;

      for (let i = 0; i < barCount; i++) {
        // Map bars to frequency bins
        const idx = Math.floor((i / barCount) * bufferLength);
        const value = dataArray[idx] / 255;
        const barHeight = Math.max(2, value * h * 0.9);

        // Center bars vertically
        const x = i * (barWidth + gap);
        const y = (h - barHeight) / 2;

        ctx.fillStyle = `rgba(139, 180, 220, ${0.4 + value * 0.6})`;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, 1);
        ctx.fill();
      }
    };

    draw();

    return () => {
      cancelAnimationFrame(animRef.current);
      source.disconnect();
      audioCtx.close();
    };
  }, [stream]);

  return (
    <canvas
      ref={canvasRef}
      width={160}
      height={32}
      className={className}
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
