package auth

import (
	"testing"
	"time"
)

func TestIssueVerifyRoundTrip(t *testing.T) {
	iss := NewIssuer("secret", time.Hour)
	tok, exp := iss.Issue("alice", RoleOperator)
	if !exp.After(time.Now()) {
		t.Fatalf("expiry should be in the future")
	}
	u, err := iss.Verify(tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if u.Subject != "alice" || u.Role != RoleOperator {
		t.Fatalf("got %+v", u)
	}
}

func TestVerifyRejectsTamperedAndWrongSecret(t *testing.T) {
	iss := NewIssuer("secret", time.Hour)
	tok, _ := iss.Issue("bob", RoleViewer)
	if _, err := NewIssuer("other-secret", time.Hour).Verify(tok); err == nil {
		t.Fatal("token from a different secret must be rejected")
	}
	if _, err := iss.Verify(tok + "tampered"); err == nil {
		t.Fatal("tampered signature must be rejected")
	}
	if _, err := iss.Verify("not.a.jwt.x"); err == nil {
		t.Fatal("malformed token must be rejected")
	}
}

func TestRoleGating(t *testing.T) {
	if CanWrite(RoleViewer) {
		t.Fatal("viewer must not be able to write")
	}
	if !CanWrite(RoleOperator) || !CanWrite(RoleAdmin) {
		t.Fatal("operator/admin must be able to write")
	}
	if !IsAdmin(RoleAdmin) || IsAdmin(RoleOperator) {
		t.Fatal("admin gating wrong")
	}
}

func TestParseUsersAndAuthenticate(t *testing.T) {
	def := ParseUsers("")
	if len(def) != 3 || def["operator"].Role != RoleOperator {
		t.Fatalf("default users wrong: %+v", def)
	}
	if u, ok := Authenticate(def, "operator", "operator"); !ok || u.Role != RoleOperator {
		t.Fatalf("valid login failed: %v %+v", ok, u)
	}
	if _, ok := Authenticate(def, "operator", "wrong"); ok {
		t.Fatal("wrong password must fail")
	}
	if _, ok := Authenticate(def, "ghost", "x"); ok {
		t.Fatal("unknown user must fail")
	}
	custom := ParseUsers("u1:p1:admin,bad,u2:p2:weirdrole")
	if custom["u1"].Role != RoleAdmin {
		t.Fatalf("custom parse wrong: %+v", custom)
	}
	if custom["u2"].Role != RoleViewer { // 未知角色降级 viewer
		t.Fatalf("unknown role should downgrade to viewer: %+v", custom["u2"])
	}
}
