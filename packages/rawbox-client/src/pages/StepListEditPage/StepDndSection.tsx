import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";

import { type SortableRowProps, SortableRow } from "./SortableRow";

interface StepDndSectionProps {
  sortableRowPropsList: SortableRowProps[];
  setSortableRowPropsList: React.Dispatch<
    React.SetStateAction<SortableRowProps[]>
  >;
}

export default function StepDndSection({
  sortableRowPropsList,
  setSortableRowPropsList,
}: StepDndSectionProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, {
      // Require the mouse to move by 10 pixels before activating
      activationConstraint: {
        distance: 10,
      },
    }),
    useSensor(TouchSensor, {
      // Press delay of 100ms, with tolerance of 5px of movement
      activationConstraint: {
        delay: 100,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = active.data.current?.sortable?.index;
      const newIndex = over.data.current?.sortable?.index;

      if (typeof oldIndex == "number" && typeof newIndex == "number") {
        setSortableRowPropsList((steps) =>
          arrayMove(steps, oldIndex, newIndex)
        );
      }
    }
  }

  return (
    <>
      <DndContext
        modifiers={[restrictToVerticalAxis]}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={sortableRowPropsList}
          strategy={verticalListSortingStrategy}
        >
          {sortableRowPropsList.map((sortableRowProps) => (
            <SortableRow
              id={sortableRowProps.id}
              key={sortableRowProps.id}
              step={sortableRowProps.step}
            />
          ))}
        </SortableContext>
      </DndContext>
    </>
  );
}
