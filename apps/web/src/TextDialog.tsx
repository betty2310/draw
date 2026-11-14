import { Banner, Button, Dialog, Input } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";

export interface TextDialogProps {
  title: string;
  /** Text of the input. Without it, the dialog only asks to confirm. */
  label?: string;
  initial?: string;
  note?: string;
  submit: string;
  danger?: boolean;
  /** Can be empty, for example to remove the name of a version. */
  allowEmpty?: boolean;
  onSubmit: (value: string) => Promise<void>;
}

/** A small modal form for a name, or a confirm of a delete. */
export function TextDialog({
  title,
  label,
  initial = "",
  note,
  submit,
  danger,
  allowEmpty,
  onSubmit,
  onClose,
}: TextDialogProps & { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={setOpen}
      // The caller removes the dialog after the close animation.
      onOpenChangeComplete={(isOpen) => !isOpen && onClose()}
      // A confirm of a delete closes only with a button.
      role={danger ? "alertdialog" : "dialog"}
    >
      <Dialog size="lg" className="p-6">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await onSubmit(value.trim());
              setOpen(false);
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason));
              setBusy(false);
            }
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            {note && (
              <Dialog.Description className="text-sm text-kumo-subtle">{note}</Dialog.Description>
            )}
          </div>
          {label && (
            <Input
              label={label}
              value={value}
              autoFocus
              maxLength={200}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          {error && (
            <Banner
              variant="error"
              size="sm"
              icon={<WarningCircleIcon weight="fill" />}
              description={error}
            />
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
            <Button
              type="submit"
              variant={danger ? "destructive" : "primary"}
              loading={busy}
              disabled={!!label && !allowEmpty && !value.trim()}
            >
              {submit}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
