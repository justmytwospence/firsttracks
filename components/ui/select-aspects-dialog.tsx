"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useEffect, useState } from "react";

// Aspect type matching WASM (lowercase)
export type Aspect = 
  | "north"
  | "northeast"
  | "east"
  | "southeast"
  | "south"
  | "southwest"
  | "west"
  | "northwest"
  | "flat";

// Ordered for compass layout (starting from N, going clockwise)
const aspects: Aspect[] = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
];

// Display labels for aspects
const aspectLabels: Record<Aspect, string> = {
  north: "N",
  northeast: "NE",
  east: "E",
  southeast: "SE",
  south: "S",
  southwest: "SW",
  west: "W",
  northwest: "NW",
  flat: "Flat",
};

// Get point at a specific angle on a circle
function getPointAtAngle(angleDeg: number, radius: number, cx: number, cy: number): { x: number; y: number } {
  const angleRad = angleDeg * (Math.PI / 180);
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  };
}

// SVG path for each wedge segment
// Each wedge spans 45 degrees, centered on its compass direction
function getWedgePath(index: number, innerRadius: number, outerRadius: number, cx: number, cy: number): string {
  // Center angle for this direction (N=0 at top, going clockwise)
  // In SVG/math: -90° is top, 0° is right, 90° is bottom, 180°/-180° is left
  const centerAngle = (index * 45) - 90; // N=-90°, NE=-45°, E=0°, SE=45°, etc.
  const halfWedge = 22.5;
  
  const startAngle = centerAngle - halfWedge;
  const endAngle = centerAngle + halfWedge;
  
  // Get the 4 corners of the wedge (trapezoid)
  const outerStart = getPointAtAngle(startAngle, outerRadius, cx, cy);
  const outerEnd = getPointAtAngle(endAngle, outerRadius, cx, cy);
  const innerStart = getPointAtAngle(startAngle, innerRadius, cx, cy);
  const innerEnd = getPointAtAngle(endAngle, innerRadius, cx, cy);
  
  return `M ${innerStart.x} ${innerStart.y} L ${outerStart.x} ${outerStart.y} L ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} Z`;
}

// Get label position for each wedge (center of the wedge)
function getLabelPosition(index: number, radius: number, cx: number, cy: number): { x: number; y: number } {
  const angle = (index * 45 - 90) * (Math.PI / 180);
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  };
}

interface SelectAspectsDialogProps {
  onSelectDirections: (directions: Aspect[]) => void;
  selectedDirections: Aspect[];
  className?: string;
}

export function SelectAspectsDialog({
  onSelectDirections,
  selectedDirections,
  className,
}: SelectAspectsDialogProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<Aspect>>(
    new Set(selectedDirections)
  );

  useEffect(() => {
    setSelected(new Set(selectedDirections));
  }, [selectedDirections]);

  const cx = 100;
  const cy = 100;
  const innerRadius = 20;
  const outerRadius = 80;
  const labelRadius = 50;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className={className ?? "w-full"}>
          Avoid Aspects
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[350px]">
        <DialogHeader>
          <DialogTitle>Select aspects to avoid</DialogTitle>
          <DialogDescription>
            Click directions to toggle. Selected aspects will be avoided on steep terrain.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-center py-4">
          <svg viewBox="0 0 200 200" className="w-64 h-64" role="img" aria-label="Compass direction selector">
            <title>Compass direction selector</title>
            {aspects.map((aspect, index) => {
              const isSelected = selected.has(aspect);
              const labelPos = getLabelPosition(index, labelRadius, cx, cy);
              
              return (
                <g key={aspect} className="cursor-pointer">
                  <path
                    d={getWedgePath(index, innerRadius, outerRadius, cx, cy)}
                    fill={isSelected ? "hsl(var(--primary))" : "hsl(var(--muted))"}
                    stroke="hsl(var(--border))"
                    strokeWidth="1"
                    className="transition-[filter] hover:brightness-90 outline-none focus:outline-none"
                    role="button"
                    tabIndex={0}
                    aria-label={`${aspectLabels[aspect]} direction${isSelected ? ' (selected)' : ''}`}
                    aria-pressed={isSelected}
                    onClick={() => {
                      const newSelected = new Set(selected);
                      if (selected.has(aspect)) {
                        newSelected.delete(aspect);
                      } else {
                        newSelected.add(aspect);
                      }
                      setSelected(newSelected);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        const newSelected = new Set(selected);
                        if (selected.has(aspect)) {
                          newSelected.delete(aspect);
                        } else {
                          newSelected.add(aspect);
                        }
                        setSelected(newSelected);
                      }
                    }}
                  />
                  <text
                    x={labelPos.x}
                    y={labelPos.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={isSelected ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))"}
                    fontSize="14"
                    fontWeight="500"
                    className="pointer-events-none select-none"
                  >
                    {aspectLabels[aspect]}
                  </text>
                </g>
              );
            })}
            {/* Center octagonal hole - click to clear all */}
            <polygon
              points={Array.from({ length: 8 }, (_, i) => {
                const angle = (i * 45) - 90 - 22.5; // Vertices at boundaries between wedges
                const pt = getPointAtAngle(angle, innerRadius, cx, cy);
                return `${pt.x},${pt.y}`;
              }).join(' ')}
              fill="hsl(var(--background))"
              stroke="hsl(var(--border))"
              strokeWidth="1"
              className="cursor-pointer transition-[filter] hover:brightness-95 outline-none focus:outline-none"
              role="button"
              tabIndex={0}
              aria-label="Clear all selected directions"
              onClick={() => setSelected(new Set())}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelected(new Set());
                }
              }}
            />
          </svg>
        </div>
        <Button
          onClick={() => {
            onSelectDirections(Array.from(selected));
            setOpen(false);
          }}
        >
          Apply
        </Button>
      </DialogContent>
    </Dialog>
  );
}
