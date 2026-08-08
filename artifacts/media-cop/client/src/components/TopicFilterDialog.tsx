import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface CommandList {
  name: string;
  count: number;
}

interface TopicFilterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableLists: CommandList[];
  selectedLists: string[];
  onListsChange: (lists: string[]) => void;
}

export default function TopicFilterDialog({
  open,
  onOpenChange,
  availableLists,
  selectedLists,
  onListsChange,
}: TopicFilterDialogProps) {
  const [tempSelected, setTempSelected] = useState<string[]>(selectedLists);

  useEffect(() => {
    setTempSelected(selectedLists);
  }, [selectedLists, open]);

  const handleToggleList = (list: string) => {
    setTempSelected((prev) =>
      prev.includes(list)
        ? prev.filter((l) => l !== list)
        : [...prev, list]
    );
  };

  const handleSelectAll = () => {
    setTempSelected(availableLists.map(list => list.name));
  };

  const handleClearAll = () => {
    setTempSelected([]);
  };

  const handleApply = () => {
    onListsChange(tempSelected);
    onOpenChange(false);
  };

  // Lists are already sorted by count in Dashboard
  const sortedLists = Array.isArray(availableLists) ? availableLists : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="dialog-topic-filter">
        <DialogHeader>
          <DialogTitle>Filter by Command List</DialogTitle>
          <DialogDescription>
            Select which command lists (AFRICOM, CENTCOM, etc.) you want to see in the DataMinr First Alert feed.
            {selectedLists.length === 0 ? " All lists are shown by default." : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSelectAll}
              data-testid="button-select-all"
            >
              Select All
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearAll}
              data-testid="button-clear-all"
            >
              Clear All
            </Button>
          </div>

          <ScrollArea className="h-96 rounded-md border p-4">
            {sortedLists.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-8">
                No command lists available yet
              </div>
            ) : (
              <div className="space-y-3">
                {sortedLists.map((list) => (
                  <div
                    key={list.name}
                    className="flex items-start gap-3 hover-elevate rounded-md p-2 cursor-pointer"
                    onClick={() => handleToggleList(list.name)}
                    data-testid={`list-item-${list.name}`}
                  >
                    <Checkbox
                      id={`list-${list.name}`}
                      checked={tempSelected.includes(list.name)}
                      onCheckedChange={() => handleToggleList(list.name)}
                      onClick={(e) => e.stopPropagation()}
                      data-testid={`checkbox-list-${list.name}`}
                    />
                    <label
                      htmlFor={`list-${list.name}`}
                      className="text-sm leading-relaxed cursor-pointer flex-1"
                    >
                      {list.name}
                    </label>
                    <Badge 
                      variant="secondary" 
                      className="ml-auto no-default-hover-elevate no-default-active-elevate"
                      data-testid={`badge-count-${list.name}`}
                    >
                      {list.count}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>

          <div className="flex justify-between items-center pt-2">
            <div className="text-sm text-muted-foreground">
              {tempSelected.length === 0
                ? "Showing all lists"
                : `${tempSelected.length} of ${sortedLists.length} selected`}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel"
              >
                Cancel
              </Button>
              <Button onClick={handleApply} data-testid="button-apply">
                Apply
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
