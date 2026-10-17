import type { VisualChart } from "./protocol";

export function chartGeometry(points: VisualChart["points"]) {
  if (points.length === 0) return undefined;
  const minimum = Math.min(...points.map((point) => point.value));
  const maximum = Math.max(...points.map((point) => point.value));
  const span = maximum - minimum;
  return {
    minimum,
    maximum,
    coordinates: points.map((point, index) => ({
      x: points.length === 1 ? 300 : 52 + (index / (points.length - 1)) * 496,
      y: span === 0 ? 100 : 164 - ((point.value - minimum) / span) * 128,
    })),
  };
}
