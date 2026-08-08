import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";

interface FilterBarProps {
  selectedCategories: string[];
  onCategoryChange: (categories: string[]) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onClearFilters: () => void;
}

const categories = [
  { id: 'DEFENSE', label: 'Defense', count: 12 },
  { id: 'CONFLICT', label: 'Conflict', count: 8 },
  { id: 'POLICY', label: 'Policy', count: 15 },
  { id: 'VETERANS', label: 'Veterans', count: 6 },
  { id: 'INTEL', label: 'Intelligence', count: 9 },
  { id: 'GLOBAL', label: 'Global', count: 11 },
  { id: 'DOMESTIC', label: 'Domestic', count: 7 },
];

export default function FilterBar({
  selectedCategories,
  onCategoryChange,
  searchQuery,
  onSearchChange,
  onClearFilters
}: FilterBarProps) {
  const handleCategoryToggle = (categoryId: string) => {
    const newCategories = selectedCategories.includes(categoryId)
      ? selectedCategories.filter(id => id !== categoryId)
      : [...selectedCategories, categoryId];
    onCategoryChange(newCategories);
    console.log('Category toggled:', categoryId, 'New selection:', newCategories);
  };

  return (
    <Card className="p-3">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h3 className="font-semibold text-sm" data-testid="text-filters-title">Filters</h3>
          
          <div className="relative w-full sm:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search headlines..."
              value={searchQuery}
              onChange={(e) => {
                onSearchChange(e.target.value);
                console.log('Search query changed:', e.target.value);
              }}
              className="pl-9 pr-9 h-8"
              data-testid="input-search"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                data-testid="button-clear-search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {categories.map((category) => (
              <div key={category.id} className="flex items-center gap-2">
                <Checkbox
                  id={category.id}
                  checked={selectedCategories.includes(category.id)}
                  onCheckedChange={() => handleCategoryToggle(category.id)}
                  data-testid={`checkbox-category-${category.id.toLowerCase()}`}
                />
                <label
                  htmlFor={category.id}
                  className="text-xs cursor-pointer select-none flex items-center gap-1"
                  data-testid={`label-category-${category.id.toLowerCase()}`}
                >
                  <span>{category.label}</span>
                  <span className="text-xs text-muted-foreground font-mono">({category.count})</span>
                </label>
              </div>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onClearFilters();
              console.log('Filters cleared');
            }}
            data-testid="button-clear-filters"
          >
            Clear All
          </Button>
        </div>
      </div>
    </Card>
  );
}
