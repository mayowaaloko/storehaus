import { z } from "zod";

const passwordRules = z
  .string()
  .min(8, { error: "Password must be at least 8 characters long" })
  .max(100, { error: "Password must be at most 100 characters long" })
  .regex(/[a-z]/, {
    error: "Password must contain at least one lowercase letter",
  })
  .regex(/[A-Z]/, {
    error: "Password must contain at least one uppercase letter",
  })
  .regex(/[0-9]/, { error: "Password must contain at least one number" })
  .regex(/[^a-zA-Z0-9]/, {
    error: "Password must contain at least one special character",
  });

export const registerSchema = z
  .object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.email(),
    password: passwordRules,
    confirmPassword: passwordRules,
  })
  .refine((data) => data.password === data.confirmPassword, {
    error: "The passwords you have given do not match. Please try again.",
    path: ["confirmPassword"],
  })
  .refine((data) => !data.password.includes(data.firstName), {
    error: "Password should not contain your first name.",
    path: ["password"],
  })
  .refine((data) => !data.password.includes(data.lastName), {
    error: "Password should not contain your last name.",
    path: ["password"],
  });

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1, { error: "Password is required" }),
  twoFactorCode: z.string().optional(),
});

export const resetPasswordSchema = z
  .object({
    password: passwordRules,
    confirmPassword: passwordRules,
  })
  .refine((data) => data.password === data.confirmPassword, {
    error: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const updatePasswordSchema = z
  .object({
    oldPassword: passwordRules,
    newPassword: passwordRules,
    confirmPassword: passwordRules,
  })
  .refine((data) => data.oldPassword !== data.newPassword, {
    error: "New password cannot be the same as the old password",
    path: ["newPassword"],
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    error: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type Register = z.infer<typeof registerSchema>;
export type Login = z.infer<typeof loginSchema>;
export type Update = z.infer<typeof updatePasswordSchema>;
export type Reset = z.infer<typeof resetPasswordSchema>;
