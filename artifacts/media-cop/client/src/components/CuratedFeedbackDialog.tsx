import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CheckCircle2, Loader2, MessageSquare } from "lucide-react";

const feedbackFormSchema = z
  .object({
    feedbackType: z.enum(["request", "suggestion", "question"], {
      required_error: "Please select a type",
    }),
    message: z.string().min(1, "Message is required").max(4000, "Message is too long"),
    anonymous: z.boolean().default(false),
    wantsFollowUp: z.boolean().default(false),
    contactName: z.string().max(200).optional(),
    contactEmail: z.string().max(300).optional(),
    contactOrg: z.string().max(200).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.wantsFollowUp && !val.anonymous) {
      if (!val.contactEmail || val.contactEmail.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Email is required when requesting follow-up",
          path: ["contactEmail"],
        });
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.contactEmail.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Enter a valid email address",
          path: ["contactEmail"],
        });
      }
    }
  });

type FeedbackFormValues = z.infer<typeof feedbackFormSchema>;

const FEEDBACK_TYPE_LABELS: Record<string, string> = {
  request: "Request",
  suggestion: "Suggestion",
  question: "Question about MCOP",
};

interface CuratedFeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function CuratedFeedbackDialog({ open, onOpenChange }: CuratedFeedbackDialogProps) {
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<FeedbackFormValues>({
    resolver: zodResolver(feedbackFormSchema),
    defaultValues: {
      feedbackType: undefined,
      message: "",
      anonymous: true,
      wantsFollowUp: false,
      contactName: "",
      contactEmail: "",
      contactOrg: "",
    },
  });

  const anonymous = form.watch("anonymous");
  const wantsFollowUp = form.watch("wantsFollowUp");

  const submitMutation = useMutation({
    mutationFn: async (values: FeedbackFormValues) => {
      const payload: Record<string, unknown> = {
        feedbackType: values.feedbackType,
        message: values.message,
        anonymous: values.anonymous,
        wantsFollowUp: values.anonymous ? false : values.wantsFollowUp,
        contactName: values.anonymous ? null : (values.contactName?.trim() || null),
        contactEmail: values.anonymous ? null : (values.contactEmail?.trim() || null),
        contactOrg: values.anonymous ? null : (values.contactOrg?.trim() || null),
      };
      return await apiRequest("POST", "/api/curated/feedback", payload);
    },
    onSuccess: () => {
      setSubmitted(true);
    },
    onError: (e: Error) => {
      toast({ title: "Could not submit feedback", description: e.message, variant: "destructive" });
    },
  });

  function handleOpenChange(v: boolean) {
    if (!v) {
      setTimeout(() => {
        setSubmitted(false);
        form.reset();
      }, 200);
    }
    onOpenChange(v);
  }

  function onSubmit(values: FeedbackFormValues) {
    submitMutation.mutate(values);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4" />
            Send feedback
          </DialogTitle>
          <DialogDescription>
            Share a request, suggestion, or question with the MCOP team.
          </DialogDescription>
        </DialogHeader>

        {submitted ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle2 className="w-10 h-10 text-green-600 dark:text-green-400" />
            <div className="text-sm font-medium">Feedback received</div>
            <div className="text-xs text-muted-foreground">
              Thank you. The MCOP team will review your submission.
            </div>
            <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} data-testid="button-feedback-close">
              Close
            </Button>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="feedbackType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs font-medium">Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-feedback-type">
                          <SelectValue placeholder="Select a type…" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="request">Request</SelectItem>
                        <SelectItem value="suggestion">Suggestion</SelectItem>
                        <SelectItem value="question">Question about MCOP</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="message"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs font-medium">Message</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Your feedback…"
                        className="resize-none min-h-[100px] text-sm"
                        {...field}
                        data-testid="textarea-feedback-message"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="rounded-md border border-border p-3 space-y-3">
                <FormField
                  control={form.control}
                  name="wantsFollowUp"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <FormLabel className="text-xs font-medium">Would you like to be contacted?</FormLabel>
                        <div className="text-[11px] text-muted-foreground">
                          If yes, your contact details below will be shared with editors.
                        </div>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={(v) => {
                            field.onChange(v);
                            if (v) form.setValue("anonymous", false);
                          }}
                          data-testid="switch-wants-followup"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {wantsFollowUp && !anonymous && (
                  <div className="space-y-2 pt-1">
                    <FormField
                      control={form.control}
                      name="contactName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">Name <span className="text-muted-foreground">(optional)</span></FormLabel>
                          <FormControl>
                            <Input className="h-8 text-sm" {...field} data-testid="input-contact-name" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="contactEmail"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">
                            Email <Badge variant="secondary" className="text-[10px] ml-1">Required for follow-up</Badge>
                          </FormLabel>
                          <FormControl>
                            <Input type="email" className="h-8 text-sm" {...field} data-testid="input-contact-email" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="contactOrg"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">Organization <span className="text-muted-foreground">(optional)</span></FormLabel>
                          <FormControl>
                            <Input className="h-8 text-sm" {...field} data-testid="input-contact-org" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}

                <FormField
                  control={form.control}
                  name="anonymous"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between gap-3 pt-1">
                      <div className="space-y-0.5">
                        <FormLabel className="text-xs font-medium">Submit anonymously</FormLabel>
                        <div className="text-[11px] text-muted-foreground">
                          Contact fields will not be sent.
                        </div>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={(v) => {
                            field.onChange(v);
                            if (v) form.setValue("wantsFollowUp", false);
                          }}
                          data-testid="switch-anonymous"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                  data-testid="button-feedback-cancel"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="curated"
                  disabled={submitMutation.isPending}
                  data-testid="button-feedback-submit"
                >
                  {submitMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Sending…</>
                  ) : (
                    "Send feedback"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
