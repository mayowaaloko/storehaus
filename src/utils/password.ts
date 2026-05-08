import argon2 from "argon2";

export const hashPassword = async (password: string) => {
  const hashedPassword = await argon2.hash(password);
  return hashedPassword;
};

export const comparePassword = async (
  password: string,
  oldPassword: string,
) => {
  const isValid = await argon2.verify(oldPassword, password);
  return isValid;
};
