import FilterSidebar from '../FilterSidebar';
import { useState } from 'react';

export default function FilterSidebarExample() {
  const [selectedCategories, setSelectedCategories] = useState<string[]>(['DEFENSE']);
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <FilterSidebar
      selectedCategories={selectedCategories}
      onCategoryChange={setSelectedCategories}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      onClearFilters={() => {
        setSelectedCategories([]);
        setSearchQuery('');
      }}
    />
  );
}
