import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";
import { useState } from "react";

interface FilterSidebarProps {
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

export default function FilterSidebar({
  selectedCategories,
  onCategoryChange,
  searchQuery,
  onSearchChange,
  onClearFilters
}: FilterSidebarProps) {
  const handleCategoryToggle = (categoryId: string) => {
    const newCategories = selectedCategories.includes(categoryId)
      ? selectedCategories.filter(id => id !== categoryId)
      : [...selectedCategories, categoryId];
    onCategoryChange(newCategories);
    console.log('Category toggled:', categoryId, 'New selection:', newCategories);
  };

  return (
    <Card className="p-4 sticky top-20">
      <div className="space-y-6">
        <div>
          <h3 className="font-semibold mb-3" data-testid="text-filters-title">Filters</h3>
          
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search headlines..."
              value={searchQuery}
              onChange={(e) => {
                onSearchChange(e.target.value);
                console.log('Search query changed:', e.target.value);
              }}
              className="pl-9 pr-9"
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

        <div>
          <h4 className="text-sm font-semibold mb-3" data-testid="text-categories-title">Categories</h4>
          <div className="space-y-2">
            {categories.map((category) => (
              <div key={category.id} className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id={category.id}
                    checked={selectedCategories.includes(category.id)}
                    onCheckedChange={() => handleCategoryToggle(category.id)}
                    data-testid={`checkbox-category-${category.id.toLowerCase()}`}
                  />
                  <label
                    htmlFor={category.id}
                    className="text-sm cursor-pointer select-none"
                    data-testid={`label-category-${category.id.toLowerCase()}`}
                  >
                    {category.label}
                  </label>
                </div>
                <span className="text-xs text-muted-foreground font-mono" data-testid={`text-count-${category.id.toLowerCase()}`}>
                  {category.count}
                </span>
              </div>
            ))}
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => {
            onClearFilters();
            console.log('Filters cleared');
          }}
          data-testid="button-clear-filters"
        >
          Clear All Filters
        </Button>
      </div>
    </Card>
  );
}
