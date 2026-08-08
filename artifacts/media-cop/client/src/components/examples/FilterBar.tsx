import FilterBar from '../FilterBar';
import { useState } from 'react';

export default function FilterBarExample() {
  const [selectedCategories, setSelectedCategories] = useState<string[]>(['DEFENSE']);
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <FilterBar
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
