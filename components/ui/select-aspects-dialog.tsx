"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  north: "North",
  northeast: "Northeast",
  east: "East",
  southeast: "Southeast",
  south: "South",
  southwest: "Southwest",
  west: "West",
  northwest: "Northwest",
  flat: "Flat",
};

interface SelectAspectsDialogProps {
  onSelectDirections: (directions: Aspect[]) => void;
  selectedDirections: Aspect[];
}

export function SelectAspectsDialog({
  onSelectDirections,
  selectedDirections,
}: SelectAspectsDialogProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<Aspect>>(
    new Set(selectedDirections)
  );

  // Sync internal state when prop changes (e.g., from chart clicks)
  useEffect(() => {
    setSelected(new Set(selectedDirections));
  }, [selectedDirections]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="w-full">
          {selectedDirections.length
            ? `Avoiding ${selectedDirections.map(a => aspectLabels[a]).join(", ")}`
            : "Choose aspects to avoid"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Select aspects to avoid</DialogTitle>
          <DialogDescription>
            Selected aspects will be excluded from the path if they exceed 5% gradient.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-4 gap-2">
          {aspects.map((direction) => (
            <Card
              key={direction}
              className={`p-2 text-center cursor-pointer hover:bg-accent ${
                selected.has(direction)
                  ? "bg-primary text-primary-foreground"
                  : ""
              }`}
              onClick={() => {
                const newSelected = new Set(selected);
                if (selected.has(direction)) {
                  newSelected.delete(direction);
                } else {
                  newSelected.add(direction);
                }
                setSelected(newSelected);
              }}
            >
              {aspectLabels[direction]}
            </Card>
          ))}
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
