"use client";

import fetchActivities from "@/app/actions/fetchActivities";
import ActivityTable from "@/components/activity-table";
import SortDropdown, {
  type SortDirection,
  type SortOption,
} from "@/components/course-sort-dropdown";
import TypeDropdown from "@/components/course-type-dropdown";
import Pagination from "@/components/pagination";
import SyncActivitiesButton from "@/components/sync-activities-button";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { baseLogger } from "@/lib/logger";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function ActivitiesPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const searchParams = useSearchParams();
  const initialType = searchParams.get("type") || undefined;
  const initialPage = Number.parseInt(searchParams.get("page") || "1", 10);
  const initialSortBy =
    (searchParams.get("sortBy") as SortOption) || "startDate";
  const initialSortDir =
    (searchParams.get("sortDir") as SortDirection) || "desc";

  const [selectedType, setSelectedType] = useState<string | undefined>(
    initialType
  );
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [sortBy, setSortBy] = useState<SortOption>(initialSortBy);
  const [sortDir, setSortDir] = useState<SortDirection>(initialSortDir);
  const itemsPerPage = 16;

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);

  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["activities", selectedType, currentPage],
    queryFn: () => fetchActivities(selectedType || "all", currentPage),
    placeholderData: (prev) => prev,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  const totalActivities = data?.activityCountsTotal || 0;
  const activityCounts = data?.activityCountsByType || {};
  const totalActivitiesForType = !selectedType
    ? totalActivities
    : activityCounts[selectedType] || 0;
  const totalPages = Math.ceil(totalActivitiesForType / itemsPerPage);
  const activityTypes = Object.keys(activityCounts);

  function prefetchType(filterType: string) {
    queryClient.prefetchQuery({
      queryKey: ["activities", filterType, 1],
      queryFn: () => fetchActivities(filterType, 1),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
    });
  }

  useEffect(() => {
    activityTypes.map(prefetchType);
  }, [activityTypes]);

  useEffect(() => {
    if (currentPage < totalPages) {
      queryClient.prefetchQuery({
        queryKey: ["activities", selectedType, currentPage + 1],
        queryFn: () => fetchActivities(selectedType || "all", currentPage + 1),
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
      });
    }
  }, [activityTypes, currentPage]);

  const updateUrlParameter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.push(`/activities?${params.toString()}`);
  };

  const handleTypeChange = (type?: string) => {
    baseLogger.debug(`Selected type: ${type}`);
    setSelectedType(type);
    setCurrentPage(1);
    updateUrlParameter("type", type || "");
  };

  const handleSortChange = (value: SortOption) => {
    setSortBy(value);
    updateUrlParameter("sortBy", value);
  };

  const handleSortDirToggle = () => {
    const newSortDir = sortDir === "asc" ? "desc" : "asc";
    setSortDir(newSortDir);
    updateUrlParameter("sortDir", newSortDir);
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    updateUrlParameter("page", page.toString());
  };

  const handleSelection = (id: string) => {
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter((i) => i !== id));
    } else {
      setSelectedIds([...selectedIds, id]);
    }
  };

  return (
    <div className="mt-8">
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center space-x-4">
          <h1 className="text-2xl font-bold">Activities</h1>

          <Button
            variant="outline"
            onClick={() => {
              setSelectionMode(!selectionMode);
              setSelectedIds([]);
            }}
          >
            {selectionMode ? "Exit Selection" : "Select Multiple"}
          </Button>
        </div>

        <SyncActivitiesButton />
      </div>
      {isLoading ? (
        <div className="flex justify-center items-center h-screen">
          <Spinner className="h-8 w-8" />
        </div>
      ) : !data?.activities ? (
        <p>Please Sync Activities</p>
      ) : (
        <>
          <div className="flex justify-between items-center mb-4">
            <div className="flex space-x-4">
              <TypeDropdown
                selectedType={selectedType}
                courseTypes={activityTypes}
                handleTypeChange={handleTypeChange}
              />
              <SortDropdown
                sortBy={sortBy}
                sortDir={sortDir}
                handleSortChange={handleSortChange}
                handleSortDirToggle={handleSortDirToggle}
              />
            </div>
            <div className="flex justify-end">
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                handlePageChange={handlePageChange}
              />
            </div>
          </div>
          <ActivityTable
            activities={data.activities}
            sortBy={sortBy}
            sortDir={sortDir}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggleSelection={handleSelection}
          />
        </>
      )}
    </div>
  );
}