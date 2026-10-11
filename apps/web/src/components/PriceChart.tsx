import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

import type { Candle } from '@kinetix/shared';

/* ============================================================================
 * Candlestick chart.
 *
 * Uses lightweight-charts v5's unified `addSeries(SeriesDefinition, options)`
 * API, with the series types imported individually. Styling is pushed to the
 * design tokens so the canvas does not look like a stock charting widget: no
 * gridlines, a muted crosshair, and the emerald/crimson execution palette.
 * ==========================================================================*/

export interface ExecutionMarkerInput {
  ts: number;
  price: number;
  side: 'buy' | 'sell';
  effect: 'entry' | 'exit';
  label: string;
}

export interface PriceChartProps {
  candles: Candle[];
  markers: ExecutionMarkerInput[];
  /** Latest tick, applied incrementally rather than re-setting the series. */
  tick: { price: number; t: number; ts: number } | null;
  height?: number;
  onCrosshair?: (info: { price: number; time: number } | null) => void;
}

const TOKENS = {
  up: '#4edea3',
  down: '#ff929a',
  primary: '#38bdf8',
  text: '#bdc8d1',
  grid: 'rgba(148, 163, 184, 0.05)',
  background: 'transparent',
} as const;

function toBar(candle: Candle): CandlestickData<Time> {
  return {
    time: Math.floor(candle.t / 1000) as UTCTimestamp,
    open: candle.o,
    high: candle.h,
    low: candle.l,
    close: candle.c,
  };
}

export function PriceChart({ candles, markers, tick, height = 360, onCrosshair }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // EMA 21 over the closes — the overlay the design shows on the chart.
  const ema = useMemo(() => {
    if (candles.length === 0) return [] as LineData<Time>[];
    const period = 21;
    const k = 2 / (period + 1);
    const out: LineData<Time>[] = [];
    let previous = candles[0]?.c ?? 0;
    candles.forEach((candle, index) => {
      previous = index === 0 ? candle.c : candle.c * k + previous * (1 - k);
      out.push({ time: Math.floor(candle.t / 1000) as UTCTimestamp, value: Number(previous.toFixed(6)) });
    });
    return out;
  }, [candles]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const chart = createChart(container, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: TOKENS.background },
        textColor: TOKENS.text,
        fontFamily: '"JetBrains Mono Variable", monospace',
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: TOKENS.grid },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.08, bottom: 0.26 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(142, 213, 255, 0.35)', width: 1, style: 3, labelBackgroundColor: '#171f33' },
        horzLine: { color: 'rgba(142, 213, 255, 0.35)', width: 1, style: 3, labelBackgroundColor: '#171f33' },
      },
      handleScale: { axisPressedMouseMove: false },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: TOKENS.up,
      downColor: TOKENS.down,
      borderUpColor: TOKENS.up,
      borderDownColor: TOKENS.down,
      wickUpColor: TOKENS.up,
      wickDownColor: TOKENS.down,
      priceLineColor: TOKENS.primary,
      priceLineStyle: 2,
    });

    const emaSeries = chart.addSeries(LineSeries, {
      color: 'rgba(56, 189, 248, 0.7)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    markersRef.current = createSeriesMarkers(candleSeries, []);

    if (onCrosshair) {
      chart.subscribeCrosshairMove((param) => {
        const bar = param.seriesData.get(candleSeries) as CandlestickData<Time> | undefined;
        if (!bar || param.time === undefined) {
          onCrosshair(null);
          return;
        }
        onCrosshair({ price: Number(bar.close), time: Number(param.time) * 1000 });
      });
    }

    chartRef.current = chart;
    candleRef.current = candleSeries;
    emaRef.current = emaSeries;
    volumeRef.current = volumeSeries;

    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      markersRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      emaRef.current = null;
      volumeRef.current = null;
    };
  }, [height, onCrosshair]);

  // Full data set on symbol / timeframe / history change.
  useEffect(() => {
    const candleSeries = candleRef.current;
    const emaSeries = emaRef.current;
    const volumeSeries = volumeRef.current;
    if (!candleSeries || !emaSeries || !volumeSeries) return;

    candleSeries.setData(candles.map(toBar));
    emaSeries.setData(ema);
    volumeSeries.setData(
      candles.map((candle) => ({
        time: Math.floor(candle.t / 1000) as UTCTimestamp,
        value: candle.v,
        color: candle.c >= candle.o ? 'rgba(78, 222, 163, 0.25)' : 'rgba(255, 146, 154, 0.2)',
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles, ema]);

  useEffect(() => {
    const plugin = markersRef.current;
    if (!plugin) return;
    const seriesMarkers: SeriesMarker<Time>[] = markers
      .map((marker) => ({
        time: Math.floor(marker.ts / 1000) as UTCTimestamp,
        position: marker.side === 'buy' ? ('belowBar' as const) : ('aboveBar' as const),
        color: marker.side === 'buy' ? TOKENS.up : TOKENS.down,
        shape: marker.side === 'buy' ? ('arrowUp' as const) : ('arrowDown' as const),
        text: marker.label,
      }))
      // Markers must be in ascending time order or the plugin throws.
      .sort((a, b) => Number(a.time) - Number(b.time));
    plugin.setMarkers(seriesMarkers);
  }, [markers]);

  // Incremental live update: update the forming candle rather than resetting data.
  useEffect(() => {
    const candleSeries = candleRef.current;
    if (!candleSeries || !tick) return;
    const bucket = Math.floor(tick.t / 1000) as UTCTimestamp;
    const last = candles[candles.length - 1];
    if (!last) return;

    const lastBucket = Math.floor(last.t / 1000);
    if (bucket < lastBucket) return;

    if (lastBucket === bucket) {
      candleSeries.update({
        time: bucket,
        open: last.o,
        high: Math.max(last.h, tick.price),
        low: Math.min(last.l, tick.price),
        close: tick.price,
      });
    } else {
      candleSeries.update({ time: bucket, open: tick.price, high: tick.price, low: tick.price, close: tick.price });
    }
  }, [tick, candles]);

  return <div ref={containerRef} className="w-full" style={{ height }} data-testid="price-chart" />;
}
