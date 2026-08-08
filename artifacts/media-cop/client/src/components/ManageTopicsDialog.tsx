import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Settings2, Trash2, GripVertical, ArrowLeft, ArrowRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TeamSubject } from "@shared/schema";

interface TopicItemProps {
  topic: TeamSubject;
  onDelete: (topic: TeamSubject) => void;
  onMoveToOther: (topic: TeamSubject, targetIsActive: boolean) => void;
  isActive: boolean;
}

function SortableTopicItem({ topic, onDelete, onMoveToOther, isActive }: TopicItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: topic.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isSpecialTopic = topic.name === "FLASH: TOP STORIES" || topic.name === "MOST RECENT" || topic.name === "CJCS MENTIONS";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 p-2 border rounded-md bg-background mb-2"
      data-testid={`topic-item-${topic.id}`}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing p-1"
        data-testid={`topic-drag-handle-${topic.id}`}
      >
        <GripVertical className="h-4 w-4 text-muted-foreground" />
      </div>
      <span className="flex-1 text-sm truncate" data-testid={`topic-name-${topic.id}`}>
        {topic.name}
      </span>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => onMoveToOther(topic, !isActive)}
        title={isActive ? "Move to Old Topics" : "Move to Active Topics"}
        data-testid={`button-move-topic-${topic.id}`}
      >
        {isActive ? <ArrowRight className="h-3 w-3" /> : <ArrowLeft className="h-3 w-3" />}
      </Button>
      {!isSpecialTopic && (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onDelete(topic)}
          title="Delete topic"
          data-testid={`button-delete-topic-${topic.id}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

export function ManageTopicsDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [activeTopics, setActiveTopics] = useState<TeamSubject[]>([]);
  const [inactiveTopics, setInactiveTopics] = useState<TeamSubject[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [topicToDelete, setTopicToDelete] = useState<TeamSubject | null>(null);
  const [deleteMode, setDeleteMode] = useState<"delete" | "move">("move");

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const { data: topicsData, isLoading } = useQuery<{ active: TeamSubject[]; inactive: TeamSubject[] }>({
    queryKey: ["/api/team/topics/manage"],
    enabled: open,
  });

  useEffect(() => {
    if (topicsData) {
      setActiveTopics(topicsData.active);
      setInactiveTopics(topicsData.inactive);
    }
  }, [topicsData]);

  const reorderMutation = useMutation({
    mutationFn: async (updates: Array<{ id: string; isActive: boolean; position: number }>) => {
      const response = await apiRequest("PATCH", "/api/team/topics/reorder", { updates });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/team/topics/manage"] });
      queryClient.invalidateQueries({ queryKey: ["/api/team/topics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/team/subjects"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to reorder topics",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ id, mode }: { id: string; mode: "delete" | "move" }) => {
      const response = await apiRequest("DELETE", `/api/team/topics/${id}`, { mode });
      return response.json();
    },
    onSuccess: (data: { success: boolean; movedCount?: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/team/topics/manage"] });
      queryClient.invalidateQueries({ queryKey: ["/api/team/topics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/team/subjects"] });
      setDeleteDialogOpen(false);
      setTopicToDelete(null);
      toast({
        title: "Topic deleted",
        description: data.movedCount !== undefined 
          ? `Moved ${data.movedCount} items to other topics.` 
          : "All associated content was removed.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to delete topic",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleActiveDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = activeTopics.findIndex(t => t.id === active.id);
    const newIndex = activeTopics.findIndex(t => t.id === over.id);
    
    if (oldIndex !== -1 && newIndex !== -1) {
      const newOrder = arrayMove(activeTopics, oldIndex, newIndex);
      setActiveTopics(newOrder);
      
      const updates = newOrder.map((topic, index) => ({ 
        id: topic.id, 
        isActive: true, 
        position: index 
      }));
      reorderMutation.mutate(updates);
    }
  };

  const handleInactiveDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = inactiveTopics.findIndex(t => t.id === active.id);
    const newIndex = inactiveTopics.findIndex(t => t.id === over.id);
    
    if (oldIndex !== -1 && newIndex !== -1) {
      const newOrder = arrayMove(inactiveTopics, oldIndex, newIndex);
      setInactiveTopics(newOrder);
      
      const updates = newOrder.map((topic, index) => ({ 
        id: topic.id, 
        isActive: false, 
        position: index 
      }));
      reorderMutation.mutate(updates);
    }
  };

  const handleMoveToOther = (topic: TeamSubject, targetIsActive: boolean) => {
    let newActiveTopics = activeTopics;
    let newInactiveTopics = inactiveTopics;
    
    if (targetIsActive) {
      newInactiveTopics = inactiveTopics.filter(t => t.id !== topic.id);
      newActiveTopics = [...activeTopics, topic];
    } else {
      newActiveTopics = activeTopics.filter(t => t.id !== topic.id);
      newInactiveTopics = [...inactiveTopics, topic];
    }
    
    setActiveTopics(newActiveTopics);
    setInactiveTopics(newInactiveTopics);
    
    const updates: Array<{ id: string; isActive: boolean; position: number }> = [];
    newActiveTopics.forEach((t, index) => {
      updates.push({ id: t.id, isActive: true, position: index });
    });
    newInactiveTopics.forEach((t, index) => {
      updates.push({ id: t.id, isActive: false, position: index });
    });
    
    reorderMutation.mutate(updates);
  };

  const handleDeleteClick = (topic: TeamSubject) => {
    setTopicToDelete(topic);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (topicToDelete) {
      deleteMutation.mutate({ id: topicToDelete.id, mode: deleteMode });
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            title="Manage Topics"
            data-testid="button-manage-topics"
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Manage Topics</DialogTitle>
          </DialogHeader>
          
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-muted-foreground">Loading topics...</span>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Active Topics</CardTitle>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[400px] pr-4">
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleActiveDragEnd}
                    >
                      <SortableContext
                        items={activeTopics.map(t => t.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {activeTopics.length === 0 ? (
                          <p className="text-sm text-muted-foreground text-center py-4">
                            No active topics
                          </p>
                        ) : (
                          activeTopics.map((topic) => (
                            <SortableTopicItem
                              key={topic.id}
                              topic={topic}
                              onDelete={handleDeleteClick}
                              onMoveToOther={handleMoveToOther}
                              isActive={true}
                            />
                          ))
                        )}
                      </SortableContext>
                    </DndContext>
                  </ScrollArea>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Old Topics</CardTitle>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[400px] pr-4">
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleInactiveDragEnd}
                    >
                      <SortableContext
                        items={inactiveTopics.map(t => t.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {inactiveTopics.length === 0 ? (
                          <p className="text-sm text-muted-foreground text-center py-4">
                            No old topics
                          </p>
                        ) : (
                          inactiveTopics.map((topic) => (
                            <SortableTopicItem
                              key={topic.id}
                              topic={topic}
                              onDelete={handleDeleteClick}
                              onMoveToOther={handleMoveToOther}
                              isActive={false}
                            />
                          ))
                        )}
                      </SortableContext>
                    </DndContext>
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Topic</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the Topic: <strong>{topicToDelete?.name}</strong>?
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="py-4">
            <RadioGroup value={deleteMode} onValueChange={(v) => setDeleteMode(v as "delete" | "move")}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="delete" id="delete-content" data-testid="radio-delete-content" />
                <Label htmlFor="delete-content">Delete all associated News Stories and Social Media Posts</Label>
              </div>
              <div className="flex items-center space-x-2 mt-2">
                <RadioGroupItem value="move" id="move-content" data-testid="radio-move-content" />
                <Label htmlFor="move-content">Move associated News Stories and Social Media Posts to other Topics</Label>
              </div>
            </RadioGroup>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-topic">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-topic"
            >
              {deleteMutation.isPending ? "Deleting..." : "Yes, delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
